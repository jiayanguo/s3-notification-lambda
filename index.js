'use strict'

const async = require('async');
const AWS = require('aws-sdk');
const gm = require('gm')
  .subClass({
    imageMagick: true
  }); // Enable ImageMagick integration.
const util = require('util');
const config = require('./config')
const s3 = new AWS.S3(config.S3_PROFILE)

exports.handler = (event, context, callback) => {
  // Read options from the event.
  console.log("Reading options from event:\n", util.inspect(event, {
    depth: 5
  }));

  let srcBucket = event.Records[0].s3.bucket.name;
  // Object key may have spaces or unicode non-ASCII characters.
  let srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
  let dstBucket = config.DESTINATION_BUCKET;

  // Sanity check: validate that source and destination are different buckets.
  if (srcBucket == dstBucket) {
    callback("Source and destination buckets are the same.");
    return;
  }

  // Infer the image type.
  let typeMatch = srcKey.match(/\.([^.]*)$/);
  if (!typeMatch) {
    callback("Could not determine the image type.");
    return;
  }

  let dstKey = srcKey.substr(0, srcKey.lastIndexOf('.'));
  let imageType = typeMatch[1];

  if (imageType != "jpg" && imageType != "png") {
    callback('Unsupported image type: ${imageType}');
    return;
  }

  // Download the image from S3, transform, and upload to a different S3 bucket.
  async.waterfall([
    (next) => {
      console.log("get object from original bucket")
      // Download the image from S3 into a buffer.
      const params = {
        Bucket: srcBucket,
        Key: srcKey
      }
      s3.getObject(params, next)
    },
    (response, next) => {
      // delete objects in resized bucket
      console.log("removing resized images in resized bucket")

      let params = {
        Bucket: dstBucket,
        Prefix: dstKey
      };
      s3.listObjects(params, (err, data) => {
        if (err) {
          console.log(err)
          next(null, response)
        }
        if (data.Contents.length == 0) {
          console.log("empty bucket")
          next(null, response)
        } else {

          try {
            let deleteParams = { Bucket: dstBucket };
            deleteParams.Delete = { Objects: [] };
            data.Contents.forEach(content => {
              deleteParams.Delete.Objects.push({ Key: content.Key });
            });

            s3.deleteObjects(deleteParams, (err, data) => {
              if (err) {
                console.log(err)
              }
              next(null, response)
            })
          } catch (err) {
            next(null, response)
          }
        }
      })

    },
    (response, next) => {
      console.log("transform images")
      let counter = 0;
      gm(response.Body).size(function (err, size) {
        // Infer the scaling factor to avoid stretching the image unnaturally.
        config.REZIED_IMAGE_DIMENSION.forEach((size) => {
          this.resize(size.w, size.h)
            .toBuffer(imageType, function (err, buffer) {
              if (err) {
                console.log('resize error!' + err)
              } else {
                console.log('image resized')

                const params = {
                  Bucket: dstBucket,
                  ContentType: imageType,
                  Key: dstKey + '/' + `${size.w}x${size.h}.${imageType}`,
                  Body: buffer,
                }
                s3.putObject(params, (err, data) => {
                  if (err) {
                    console.log("Exception while writing resized image to bucket " + err)
                    counter++
                    if (counter >= config.REZIED_IMAGE_DIMENSION.length) {
                      next(null)
                    }
                  } else {
                    counter++;
                    if (counter >= config.REZIED_IMAGE_DIMENSION.length) {
                      next(null)
                    }
                  }
                })
              }
            })
        })

      })
    },
    (next) => {
      console.log("invalidate CF cache")
      let cloudfront = new AWS.CloudFront();
      let distributionId = "EXTXR9VKT6HRY";
      let path = "/dev/imageserver/custom*";
      let cf_params = {
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: '' + new Date().getTime(), Paths: {
            Quantity: 1,
            Items: [path]
          }
        }
      };
      // Invalidate
      cloudfront.createInvalidation(cf_params,
        function (err, data) {
          if (err) { console.log('Error while invalidtaing: ', err); return; }
          console.log('Successfully Invalidated the file: ', data.InvalidationBatch);
          next(null)
        });
    }
  ], function (err) {
    if (err) {
      console.error(
        'Unable to resize ' + srcBucket + '/' + srcKey +
        ' and upload to ' + dstBucket + '/' + dstKey +
        ' due to an error: ' + JSON.stringify(err)
      );
    } else {
      console.log(
        'Successfully resized ' + srcBucket + '/' + srcKey +
        ' and uploaded to ' + dstBucket + '/' + dstKey
      );
    }

    callback(null, "message");
  });
};
