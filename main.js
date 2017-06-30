#!/usr/bin/env node
'use strict'

const path = require('path')
const fs = require('fs')
const CSVParser = require('csv-parse')
const camelCase = require('camel-case')
const AWS = require('aws-sdk')
const exporter = require('highcharts-export-server')
const moment = require('moment')
const Slack = require('slack-node')

const METRIC = process.env.METRIC || 'AWS/EC2/CPUUtilization'
const METRIC_NAME = process.env.METRIC_NAME || 'Average'
// Time range to show in the chart
const TIME_AGO = process.env.TIME_AGO ? Number(process.env.TIME_AGO) : 6 * 60 * 60 * 1000 // 1h ago
const SEARCH = process.env.SEARCH || '.*'
// const SEARCH = 'network australia'

// At least the instance should reach this threshold to show in the chart
const THRESHOLD_TO_SHOW = process.env.THRESHOLD_TO_SHOW ? Number(process.env.THRESHOLD_TO_SHOW) : 30
const THRESHOLD_WARN_MIN = process.env.THRESHOLD_WARN_MIN ? Number(process.env.THRESHOLD_WARN_MIN) : 75
const THRESHOLD_WARN_MAX = process.env.THRESHOLD_WARN_MAX ? Number(process.env.THRESHOLD_WARN_MAX) : 90
const THRESHOLD_WARN = [THRESHOLD_WARN_MIN, THRESHOLD_WARN_MAX]
const THRESHOLD_ERR_MIN = process.env.THRESHOLD_ERR_MIN ? Number(process.env.THRESHOLD_ERR_MIN) : 90
const THRESHOLD_ERR_MAX = process.env.THRESHOLD_ERR_MAX ? Number(process.env.THRESHOLD_ERR_MAX) : 100
const THRESHOLD_ERR = [THRESHOLD_ERR_MIN, THRESHOLD_ERR_MAX]
// How long should be over threshold to alert
const THRESHOLD_TIME = process.env.THRESHOLD_TIME ? Number(process.env.THRESHOLD_TIME) : 15 // min

// Cron time for this script
const TRIGGER_INTERVAL = process.env.TRIGGER_INTERVAL ? Number(process.env.TRIGGER_INTERVAL) : THRESHOLD_TIME
// How many run points to trigger err
const TRIGGER_ERR_POINTS = process.env.TRIGGER_ERR_POINTS ? Number(process.env.TRIGGER_ERR_POINTS) : 1
// How many run points to fix an alarm
const TRIGGER_FIX_POINTS = process.env.TRIGGER_FIX_POINTS ? Number(process.env.TRIGGER_FIX_POINTS) : 3

const SLACK_ENABLED = Boolean(process.env.SLACK_ENABLED ? Number(process.env.SLACK_ENABLED) : 1)
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || '#cloudwatch-alert-test'
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || 'https://hooks.slack.com/services/NEEDS_TO_DEFINE'
const SLACK_USERNAME = process.env.SLACK_USERNAME || 'CloudWatch Alerts'

const CHART_TITLE = process.env.CHART_TITLE || 'Cloud Instances CPUUtilization'
const CHART_SIZE_FACTOR = Number(process.env.CHART_SIZE_FACTOR ? process.env.CHART_SIZE_FACTOR : 0.2)

const AWS_CREDENTIALS_CSV_FILE = process.env.AWS_CREDENTIALS_CSV_FILE || 'creds.csv'
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'cloudwatch-charts'

// CACHE //
var CRegions = null
var CInstances = null
var CMetrics = null
// /CACHE /

var slack = new Slack()
slack.setWebhook(SLACK_WEBHOOK)

exports.handler = (event, context, callback) => {
  // console.log(event, context)

  context.callbackWaitsForEmptyEventLoop = false
  AWSInit(true)
  .then(() => main(event, context))
  .then(url => callback(null, url), err => callback(err))
  .then(() => context.succeed())
}

function main (event, context) {
  return new Promise((resolve, reject) => {
    exporter.initPool()

    Promise.all([
      getCloudWatchMetricsRegionAware(),
      getEC2InstanceDataRegionAware(),
      guessTriggerInterval(event)
    ]).then(data => {
      var metrics = data[0]
      var instances = data[1]
      var triggerInterval = data[2]
      var promises = []

      var startTime = new Date(Number((new Date().getTime() - TIME_AGO).toFixed()))
      var endTime = new Date()

      for (let region in instances) {
        var ids = instances[region].filter(i => new RegExp(`${SEARCH}`, 'ig').test(i.name)).map(i => i.id)

        if (ids.every(id => metrics[region][METRIC].InstanceId.indexOf(id) !== -1)) {
          ids = ids.filter(id => {
            let valid = (metrics[region][METRIC].InstanceId.indexOf(id) !== -1)
            if (!valid) {
              let instance = instances[region].find(ins => ins.id === id)
              console.log(new Error(`${instance.name} is not available for ${METRIC}`))
            }

            return valid
          })
        }

        ids.forEach(id => promises.push(requestChartData(region, id, startTime, endTime, undefined, triggerInterval)))
      }

      var flattenedInstances = []
      for (let region in instances) {
        flattenedInstances = flattenedInstances.concat(instances[region])
      }

      parseChartData(promises, flattenedInstances)
        .then(dataSeries => renderChart('./chart.png', dataSeries, CHART_TITLE))
        .then(chartResp => {
          exporter.killPool()

          uploadToS3('current.png', Buffer.from(chartResp.data, 'base64'))
          .then(s3Resp => {
            console.log(s3Resp.Location)
            resolve(s3Resp.Location)
          })
        }).catch(err => reject(err))
    }, err => reject(err)).catch(err => reject(err))
  })
}

function requestChartData (region, id, startTime, endTime, skipAlarms = false, triggerInterval = TRIGGER_INTERVAL) {
  return new Promise((resolve, reject) => {
    var dimension = {Name: 'InstanceId', Value: id}
    var metricPromise = getMetricStatistics({
      EndTime: endTime,
      StartTime: startTime,
      Namespace: METRIC.split('/').splice(0, 2).join('/'),
      MetricName: METRIC.split('/').splice(-1).join('/'),
      Period: 60, // Must be multiple of 60
      Dimensions: [dimension],
      Statistics: [METRIC_NAME]
    }, region)

    if (!skipAlarms) {
      metricPromise.then(d => {
        let data = Object.assign({}, d)

        data.Datapoints.sort((a, b) => moment(a.Timestamp).diff(moment(b.Timestamp)))

        let possibleAlarms = []
        data.Datapoints.forEach((point, i) => {
          if (point[METRIC_NAME] >= THRESHOLD_ERR[0] && (!possibleAlarms.slice(-1).length || possibleAlarms.slice(-1)[0].endedAt)) { // New Alarm Over Error Threshold
            let alarm = {
              current: point[METRIC_NAME],
              min: point[METRIC_NAME],
              max: point[METRIC_NAME],
              startedAt: moment(new Date(point.Timestamp).getTime()),
              endedAt: null,
              minutes: 0
            }
            possibleAlarms.push(alarm)
          } else if (point[METRIC_NAME] >= THRESHOLD_ERR[0] && possibleAlarms.slice(-1).length) { // Existing Alarm Not Ended Over Error Threshold
            let alarm = possibleAlarms.slice(-1)[0]
            alarm.current = point[METRIC_NAME]
            alarm.min = point[METRIC_NAME] < alarm.min ? point[METRIC_NAME] : alarm.min
            alarm.max = point[METRIC_NAME] > alarm.max ? point[METRIC_NAME] : alarm.max
          } else if (point[METRIC_NAME] < THRESHOLD_ERR[0] && possibleAlarms.slice(-1).length &&
            !possibleAlarms.slice(-1)[0].endedAt) { // Existing Alarm That Ends Now
            let alarm = possibleAlarms.slice(-1)[0]
            alarm.endedAt = moment(new Date(point.Timestamp).getTime())
            alarm.minutes = alarm.endedAt.diff(alarm.startedAt, 'minutes')
          } else if (i === (data.Datapoints.length - 1) &&
            possibleAlarms.slice(-1).length && !possibleAlarms.slice(-1)[0].endedAt) { // Not Ended Alarm And Last DataPoint, end it now
            let alarm = possibleAlarms.slice(-1)[0]
            alarm.endedAt = moment(new Date(point.Timestamp).getTime())
            alarm.minutes = alarm.endedAt.diff(alarm.startedAt, 'minutes')
          }
        })

        // Filter false-positives
        possibleAlarms = possibleAlarms.filter(alarm => alarm.minutes >= THRESHOLD_TIME)

        if (possibleAlarms.length) {
          let alarm = possibleAlarms.slice(-1)[0]
          let lastDataPointTS = moment(new Date(data.Datapoints.slice(-1)[0].Timestamp).getTime())
          let runTimesToEnd = Number((lastDataPointTS.diff(alarm.endedAt, 'minutes') / triggerInterval).toFixed()) - 1

          // console.log(alarm, lastDataPointTS, moment(lastDataPointTS).diff(moment(alarm.endedAt), 'minutes'), triggerInterval, runTimesToEnd, data.Datapoints.slice(-1)[0])

          switch (Number(Number(runTimesToEnd).toFixed())) {
            case TRIGGER_ERR_POINTS: // Error Alarm
              renderAlarmChart(id, region, alarm, startTime, endTime)
              .then(chartFileName => {
                console.log(`${chartFileName} created`)
                resolve(d)
              })
              .catch(err => console.log(err))
              break
            case TRIGGER_FIX_POINTS: // Restored  Alarm
              renderAlarmChart(id, region, alarm, startTime, endTime, '#90fc6c')
              .then(chartFileName => {
                console.log(`${chartFileName} created`)
                resolve(d)
              })
              .catch(err => console.log(err))
              break
            default:
              resolve(d)
              break
          }
        } else {
          resolve(d)
        }
      })
    } else {
      metricPromise.then(resolve)
    }
  })
}

function parseChartData (promises, instances) {
  return Promise.all(promises).then(data => {
    // Threshold filter
    data = data.filter(serie => {
      let valid = serie.Datapoints.some(point => point[METRIC_NAME] >= THRESHOLD_TO_SHOW)
      if (!valid) {
        instances.splice(instances.findIndex(inst => inst.id === serie.InstanceId), 1)
      }
      return valid
    })

    var dataSeriesTime = {}
    var dataSeries = []
    data.forEach((serie, i) => {
      let instance = instances.find(inst => inst.id === serie.InstanceId)

      serie.Datapoints.forEach(point => {
        let ts = new Date(point.Timestamp).getTime()
        let pointExists = Boolean(ts in dataSeriesTime)

        if (!pointExists) {
          dataSeriesTime[ts] = new Array(data.length).fill().map(() => null)
        }

        dataSeriesTime[ts][i] = point[METRIC_NAME]
        // console.log(pointExists, ts, i, dataSeriesTime[ts])
      })

      dataSeries.push({
        name: `${instance.name} @ ${instance.region}`,
        data: []
      })
    })

    var dataSeriesTimeOrdered = {}

    Object.keys(dataSeriesTime).sort().forEach(key => { dataSeriesTimeOrdered[key] = dataSeriesTime[key] })
    // console.log(JSON.stringify(dataSeriesTimeOrdered))

    for (let date in dataSeriesTimeOrdered) {
      // console.log(date)
      dataSeriesTimeOrdered[date].forEach((value, i) => dataSeries[i].data.push([Number(date), value]))
    }
    // console.log(JSON.stringify({timeOrdered: dataSeriesTimeOrdered, zdataSeries: dataSeries}))

    return dataSeries
  })
}

function renderChart (file, dataSeries, title) {
  return new Promise((resolve, reject) => {
    var settings = {
      type: 'png',
      width: 8192 * CHART_SIZE_FACTOR,
      options: {
        chart: {
          type: 'spline',
          width: 4096 * CHART_SIZE_FACTOR,
          height: 3072 * CHART_SIZE_FACTOR
        },
        xAxis: {
          type: 'datetime'
        },
        yAxis: {
          min: 0,
          max: 100,
          plotBands: [
            {
              from: THRESHOLD_ERR[0],
              to: THRESHOLD_ERR[1],
              color: 'rgba(251, 49, 49, 0.2)'
            }, {
              from: THRESHOLD_WARN[0],
              to: THRESHOLD_WARN[1],
              color: 'rgba(251, 245, 49, 0.6)'
            }
          ]
        },
        title: {
          text: title
        },
        subtitle: {
          text: moment().format()
        },
        series: dataSeries,
        plotOptions: {
          series: {
            connectNulls: true
          }
        }
      }
    }

    exporter.export(settings, (err, res) => {
      if (!err) {
        resolve(res)
      } else {
        console.log(err)
        reject(err)
      }
    })
  })
}

function AWSInit (force = false) {
  return new Promise((resolve, reject) => {
    if (!AWS.config.credentials || force) {
      var pwd = typeof __dirname !== 'undefined'
                ? __dirname : require('process').cwd()
      var parser = CSVParser({}, (err, data) => {
        if (err) {
          reject(err)
        } else {
          if (data.length !== 2) {
            reject(new Error('Invalid credentials file'))
          } else {
            var creds = {}
            data[0].forEach((el, ind) => {
              creds[camelCase(el)] = data[1][ind]
            })

            creds = new AWS.Credentials(creds)
            creds.getPromise().then(() => {
              let config = new AWS.Config({
                credentials: creds,
                region: 'eu-west-1'})

              AWS.config = config
              resolve()
            }).catch((err) => {
              reject(err)
            })
          }
        }
      })

      fs.createReadStream(path.join(pwd, AWS_CREDENTIALS_CSV_FILE)).pipe(parser)
    } else {
      AWS.config.credentials.getPromise().then(() => {
        resolve()
      }).catch((err) => {
        reject(err)
      })
    }
  }).catch((err) => {
    console.log(`Error creating credentials: ${err}`)
    return new AWS.Credentials()
  })
}

function getCloudWatchMetrics (region = null) {
  return new Promise((resolve, reject) => {
    var CW = region ? new AWS.CloudWatch({region: region}) : new AWS.CloudWatch()

    CW.listMetrics({Namespace: 'AWS/EC2'}, (err, data) => {
      if (err) {
        reject(err)
      } else {
        var metrics = {}
        data.Metrics.forEach((metric) => {
          let name = `${metric.Namespace}/${metric.MetricName}`
          if (!(name in metrics)) metrics[name] = {}

          metric.Dimensions.forEach(dim => {
            if (!(dim.Name in metrics[name])) metrics[name][dim.Name] = []
            metrics[name][dim.Name].push(dim.Value)
          })
        })

        resolve(metrics)
      }
    })
  })
}

function getEC2Regions () {
  return new Promise((resolve, reject) => {
    if (CRegions) {
      resolve(CRegions)
    } else {
      let EC2 = new AWS.EC2()
      EC2.describeRegions({}, (err, data) => {
        if (err) {
          reject(err)
        } else {
          CRegions = data.Regions.map(region => region.RegionName)
          resolve(CRegions)
        }
      })
    }
  })
}

function getEC2InstanceData (region = null) {
  if (CInstances) {
    return new Promise((resolve, reject) => resolve(CInstances[region || AWS.config.region]))
  } else {
    return new Promise((resolve, reject) => {
      var EC2 = region ? new AWS.EC2({region: region}) : new AWS.EC2()

      EC2.describeInstances({}, (err, data) => {
        if (err) {
          reject(err)
        } else {
          resolve(parseEC2InstancesData(data, EC2))
        }
      })
    })
  }
}

function getEC2InstanceDataById (id, region = null) {
  return getEC2InstanceData(region).then(instances => instances.find(instance => instance.id === id))
}

/**
 * { id: 'i-01f4ad6b429e01fb1',
 *   type: 'm3.medium',
 *   monitoring: false,
 *   region: 'eu-west-1a',
 *   publicIp: '46.51.184.122',
 *   status: 'running',
 *   name: 'S+O temporary test _ win2016' }
 */
function parseEC2InstancesData (rawData, service = null) {
  var instances = []
  rawData.Reservations.forEach(instanceGroup => {
    instanceGroup.Instances.forEach(instance => {
      var insData = {
        id: instance.InstanceId,
        type: instance.InstanceType,
        // keyName: instance.KeyName, // SSH Key Name
        monitoring: instance.Monitoring.State === 'enabled',
        region: service ? service.config.region : AWS.config.region,
        publicIp: instance.PublicIpAddress,
        status: instance.State.Name
      }

      instance.Tags.forEach(tag => {
        if (/name/i.test(tag.Key)) {
          insData.name = tag.Value
        }
      })

      instances.push(insData)
    })
  })
  return instances
}

function getMetricStatistics (params, region = null) {
  return new Promise((resolve, reject) => {
    var CW = region ? new AWS.CloudWatch({region: region}) : new AWS.CloudWatch()

    CW.getMetricStatistics(params, (err, data) => {
      if (err) {
        reject(err)
      } else {
        data.InstanceId = params.Dimensions[0].Value
        resolve(data)
      }
    })
  })
}

function getCloudWatchMetricsRegionAware () {
  if (CMetrics) {
    return new Promise((resolve, reject) => resolve(CMetrics))
  } else {
    return getEC2Regions()
      .then(regions => {
        return Promise.all(regions.map(region => getCloudWatchMetrics(region)))
          .then(data => {
            let result = {}
            data.forEach((regionData, i) => {
              result[regions[i]] = regionData
            })
            CMetrics = result
            return result
          })
      })
  }
}

function getEC2InstanceDataRegionAware () {
  if (CInstances) {
    return new Promise((resolve, reject) => resolve(CInstances))
  } else {
    return getEC2Regions()
      .then(regions => {
        return Promise.all(regions.map(region => getEC2InstanceData(region)))
      })
      .then(data => {
        let result = {}
        data.forEach(region => region.forEach(inst => {
          if (!(inst.region in result)) {
            result[inst.region] = []
          }
          result[inst.region].push(inst)
        }))
        return result
      })
  }
}

function sendSlackAlert (msg, file, statusColor = '#FF0A0A') {
  return new Promise((resolve, reject) => {
    if (!SLACK_ENABLED) {
      resolve()
    } else {
      slack.webhook({
        channel: SLACK_CHANNEL,
        username: SLACK_USERNAME,
        attachments: [
          {
            'fallback': msg,
            'color': statusColor,
            'pretext': msg,
            'image_url': file.Location
          }
        ]
      }, function (err, response) {
        if (err) {
          reject(err)
        } else {
          resolve(response)
        }
      })
    }
  })
}

function uploadToS3 (file, data) {
  return new Promise((resolve, reject) => {
    let S3 = new AWS.S3()
    S3.upload({
      Bucket: S3_BUCKET_NAME,
      Key: file,
      ACL: 'public-read',
      ContentType: 'image/png',
      Body: data
    }, (err, data) => {
      if (err) {
        console.log(`Failed to upload file to S3: ${err.message}`)
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

function guessTriggerInterval (event) {
  return new Promise((resolve, reject) => {
    var CWE = new AWS.CloudWatchEvents({region: event.region})
    if (event.resources.length > 0 && event.resources[0].indexOf(':') !== -1) {
      CWE.describeRule({Name: event.resources[0].split(':').slice(-1)[0].split('/')[1]}, (err, data) => {
        if (err) {
          console.log(`Cannot Guess TriggerInterval: ${err.message}. Setting as interval: ${TRIGGER_INTERVAL}`)
          resolve(TRIGGER_INTERVAL)
        } else {
          if (/^rate\((\d+ \w+)\)$/.test(data.ScheduleExpression)) {
            let time = data.ScheduleExpression.match(/^rate\((\d+ \w+)\)$/)[1]
            let duration = moment.duration(Number(time.split(' ')[0]), time.split(' ')[1]).asMinutes()
            resolve(Number(duration))
          } else {
            resolve(TRIGGER_INTERVAL)
          }
        }
      })
    } else {
      console.log(`Cannot Guess TriggerInterval: Invalid resource. Setting as interval: ${TRIGGER_INTERVAL}`)
      resolve(TRIGGER_INTERVAL)
    }
  })
}

function renderAlarmChart (id, region, thresholdAlarm, startTime, endTime, slackColor = '#FF0A0A') {
  return getEC2InstanceDataById(id, region).then(instance => {
    let duration = moment.duration(thresholdAlarm.minutes, 'minutes')
    let chartFileName = `alert-cpu-${id}-${new Date().getTime()}.png`
    let status = slackColor === '#FF0A0A' ? 'is over threshold' : 'has been restored'
    let message = `${instance.name} ${status} ${duration.humanize()} ago`
    console.log(message)
    return requestChartData(region, id, startTime, endTime, true)
        .then(metricPromise => parseChartData([metricPromise], [instance]))
        .then(dataSeries => renderChart(chartFileName, dataSeries, 'ALERT'))
        .then(chartResp => uploadToS3(chartFileName, Buffer.from(chartResp.data, 'base64')))
        .then(s3Resp => sendSlackAlert(message, s3Resp, slackColor), err => console.log(err))
        .then(() => chartFileName)
  })
}
