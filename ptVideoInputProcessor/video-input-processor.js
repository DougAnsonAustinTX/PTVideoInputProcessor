/*
 * ----------------------------------------------------------------------------
 * Copyright 2020 ARM Ltd.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * ----------------------------------------------------------------------------
 */

const util = require('util')
const JsonRpcWs = require('json-rpc-ws');

// mqtt support
const mqtt = require('mqtt');

// Configuration support
require('dotenv').config();

// URL support
const urlParser = require('url');

// Local Filesystem file read support
const fs = require('fs');

// Video Camera 
const NodeWebcam = require( "node-webcam" );

// AWS S3 bucket file read support
var AWS = require('aws-sdk');

// HTTP support
const { request } = require('http');

// exec support
const { exec } = require("child_process");
const { resolve } = require('path/posix');

// VERSION
const VERSION = "1.0.0";

// CONFIG

// S3 Relative capture directory
const S3_CAPTURE_RELATIVE_DIR = "video/capture";
const AWS_REGION = "us-east-1";        

// Video Input Processor API Object ID
const VIDEO_INPUT_PROCESSOR_RPC_API_OBJECT_ID = 33312;

// Video Input Processor API Command Resource ID
const VIDEO_INPUT_PROCESSOR_API_COMMAND_RESOURCE_ID = 5701;

// Video Input Processor API CONFIG Resource ID
const VIDEO_INPUT_PROCESSOR_API_CONFIG_RESOURCE_ID = 5702;

// Default JSON RPC Command
const DEFAULT_JSON_RPC_COMMAND = {};

// Video Input Processor Defaults
const DEFAULT_MODEL_TYPE                = "keras-resnet50-image-recognizer";        // default image preprocessor supports keras50 models
const DEFAULT_CAPTURE_FPS               = 5000;                                     // frame captures from video input per second (in ms)
const DEFAULT_CAPTURES_PER_PREDICTION   = 5;                                        // number of frames to capture for invoking a prediction
const DEFAULT_MODEL_IMAGE_SHAPE         = {"width":224, "height":224, "depth":3};   // default shape for captured images
const DEFAULT_VIDEO_INPUT_DEVICE        = "/dev/video0";                            // default video input device

// MQTT configuration
const MQTT_BROKER_HOSTNAME              = "127.0.0.1";                              // use the mosquitto instance in the docker host...
const MQTT_BROKER_PORT                  = 1883;                                     // std port number
const MQTT_VIDEO_INPUT_TOPIC            = "rawinput";                               // raw video input topic
const MQTT_COMMAND_TOPIC                = "command";                                // command topic
const MQTT_CLIENT_ID                    = "videoCapture";                           // clientId to use
const MQTT_USERNAME                     = "arm";                                    // default username (changeme)
const MQTT_PASSWORD                     = "changeme";                               // default password (changeme)

// File reading support - relative to mapped kubernetes mount points
const LOCAL_DIR = "/models";
const CAPTURE_DIR = LOCAL_DIR + "/" + "capture";

// Supported Commands 
const SUPPORTED_COMMANDS = 
    {
        "startCapture": {"params":["retain"]},      // start capture
        "stopCapture": {"params":[]}                // stop capture
    };

// Timeout time in milliseconds
const TIMEOUT = 10000;

// CoAP Operations
const OPERATIONS = {
    READ       : 0x01,
    WRITE      : 0x02,
    EXECUTE    : 0x04,
    DELETE     : 0x08
};

// Logging Levels
const LOGGING = {
    INFO        : 0x01,
    DEBUG       : 0x02,
    ERROR       : 0x04
};

// Command Status
const CMD_STATUS = {
    IDLE        : 'idle',
    RUNNING     : 'running',
    ERROR       : 'error'
};

// SIGINT handler
let sigintHandler;

// PT handle
let pt;

// manual sleep function
function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
}

function VideoInputProcessorPT(LOG_LEVEL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET, AWS_S3_VIDEO_CAPTURE_DIR, AWS_REGION, PT_DEVICE_NAME) {
    try {
        this.name = 'video-input-processor';
        this.log_level = LOG_LEVEL;
        this.awsRegion = AWS_REGION;

        // initialize our last command status...
        this.commandStatus = {};

        // define our PT device name 
        if (PT_DEVICE_NAME !== undefined && PT_DEVICE_NAME !== "") {
            this.name = PT_DEVICE_NAME;
        }
        this.ptDeviceName = this.name + "-0"
        
        // Build out our configuration
        this.config = {};
        this.config['config'] = {};
        this.config['config']['version'] = VERSION;
        this.config['config']['auth'] = {};
        this.config['config']['auth']['awsAccessKeyId'] = AWS_ACCESS_KEY_ID;
        this.config['config']['auth']['awsSecretAccessKey'] = AWS_SECRET_ACCESS_KEY;
        this.config['config']['awsS3Bucket'] = AWS_S3_BUCKET;
        this.config['config']['awsS3VideoCaptureDirectory'] = AWS_S3_VIDEO_CAPTURE_DIR;
        this.config['config']['awsRegion'] = AWS_REGION;
        this.config['config']['commands'] = SUPPORTED_COMMANDS;

        // Video Input Processor specific capture configurations
        this.config['config']['model'] = DEFAULT_MODEL_TYPE;
        this.config['config']['captureFPS'] = DEFAULT_CAPTURE_FPS;
        this.config['config']['shape'] = DEFAULT_MODEL_IMAGE_SHAPE;
        this.config['config']['numCapturesPerPrediction'] = DEFAULT_CAPTURES_PER_PREDICTION;
        this.config['config']['videoInputDev'] = DEFAULT_VIDEO_INPUT_DEVICE;
        this.config['config']['mqttBrokerHost'] = MQTT_BROKER_HOSTNAME;
        this.config['config']['mqttBrokerPort'] = MQTT_BROKER_PORT;
        this.config['config']['mqttUsername'] = MQTT_USERNAME;
        this.config['config']['mqttPassword'] = MQTT_PASSWORD;
        this.config['config']['mqttClientId'] = MQTT_CLIENT_ID;

        // retain or dispose of captured files (default: do not retain)
        this.config['config']['retain'] = false;

        // set the region for AWS S3 support
        AWS.config.update({region: this.config['config']['awsRegion']});

        // Edge JsonRPC Config and setup
        this.api_path = '/1/pt';
        this.socket_path = '/tmp/edge.sock';
        this.client = JsonRpcWs.createClient();

        // no capture on initially...
        this.doCapture = false;
        this.collection = [];
        this.Webcam = NodeWebcam.create(this.config['config']['cameraOptions']);

        // Initialize camera options
        this.setCameraOptions(this.config['config']['videoInputDev']);

        // MQTT configuration
        this.mqttClient = undefined;
        this.mqttUrl = "";
        this.mqttOptions = {};
        this.mqttConnected = false;
        this.updateMQTTConfiguration(this);

        // make the capture root directory
        try {
            fs.mkdirSync(CAPTURE_DIR, { recursive: true });
        }
        catch (ex) {
            // fail silently...
            this.log(LOGGING.DEBUG,"Exception in mkdirSync(): DIR: " + CAPTURE_DIR + " Exception: " + ex, ex);
        }
    }
    catch(ex) {
        this.log(LOGGING.ERROR,"Caught Exception in VideoInputProcessorPT Constructor: ", ex);
        if (ex.stack !== undefined) {
            const [, lineno, colno] = ex.stack.match(/(\d+):(\d+)/);
            console.error('Line:' + lineno + ' Column: ' + colno);
        }
    }
}

VideoInputProcessorPT.prototype.updateMQTTConfiguration = function(mypt) {
    // update our options...
    mypt.mqttUrl = `mqtt://${mypt.config['config']['mqttBrokerHost']}:${mypt.config['config']['mqttBrokerPort']}`;
    mypt.mqttOptions = {
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 1000,
        // clientId: pt.config['config']['mqttClientId'],
        // username: pt.config['config']['mqttUsername'],
        // password: pt.config['config']['mqttPassword'],
    };

    // reconnect...
    mypt.connectToMQTTBroker(mypt);
}

VideoInputProcessorPT.prototype.useSelectedDevice = function(devFile, devList) {
    for(i = 0 ;devList !== undefined && i < devList.length; ++i) {
        if (devList[i] === devFile) {
            pt.log(LOGGING.DEBUG,"Selected Camera Device: " + devList[i]);
            return devList[i];
        }
    }

    // did not find the requested device file.. so default to the first default one...
    pt.log(LOGGING.ERROR,"WARNING: Did not find requested camera device: " + devFile + " - Using default camera: " + devList[0]);
    return devList[0];
}

VideoInputProcessorPT.prototype.setCameraOptions = function(devFile) {
    NodeWebcam.list( function( list ) { 
        // Set the camera options
        pt.config['config']['cameraOptions'] = {
            width: pt.config['config']['shape']['width'],
            height: pt.config['config']['shape']['height'],
            quality: 100,
            frames: pt.config['config']['numCapturesPerPrediction'],
            saveShots: false,
            output: "jpeg",
            filenameSuffix: "jpg",              // align with output format type prior...
            device: pt.useSelectedDevice(devFile,list),
            callbackReturn: "base64",
            verbose: false
        };

        // reset any previous cameras
        pt.camera = undefined;

        // note the options
        pt.log(LOGGING.INFO,"Camera Options: " + JSON.stringify(pt.config['config']['cameraOptions']));
    });
}

VideoInputProcessorPT.prototype.doLog = function(level) {
    if (this.log_level.includes(level)) {
        return true;
    }
    return false;
}

VideoInputProcessorPT.prototype.log = function(level, message, ex) {
    let str_level = "INFO";

    switch(level) {
        case LOGGING.DEBUG:
            str_level = "DEBUG";
            break;
        case LOGGING.ERROR:
            str_level = "ERROR";
            break;
    }

    // create the JSON log entry
    const data = {};
    data['level'] = str_level;
    data['message'] = message;
    data['ts'] = new Date().toISOString();

    // add any exception details...
    if (ex !== undefined && ex.stack !== undefined) {
        const [, lineno, colno] = ex.stack.match(/(\d+):(\d+)/);
        data['exception'] = 'Exception detail: ' + ex;
        data['line'] = lineno;
        data['column'] = colno;
    }

    // log to console
    if (this.doLog(str_level)) {
        if (level == LOGGING.ERROR) {
            console.error(data);
        }
        else {
            console.log(data);
        }
    }
}

VideoInputProcessorPT.prototype.connect = async function() {
    const self = pt;
    return new Promise((resolve, reject) => {
        let url = util.format('ws+unix://%s:%s',
                              pt.socket_path,
                              pt.api_path);
        if (self.client !== undefined && self.client.isConnected() === false) {
            self.log(LOGGING.INFO,'Connecting Edge at: ' + url + '...');
            self.client.connect(url,
                function connected(error, reply) {
                    if (!error) {
                        resolve(reply);
                    } else {
                        reject(error);
                    }
                });
            }
    });
};

VideoInputProcessorPT.prototype.disconnect = async function() {
    const self = pt;
    return new Promise((resolve, reject) => {
        self.log(LOGGING.INFO,'Disconnecting from Edge.');
        self.client.disconnect((error, response) => {
            if (!error) {
                resolve(response);
            } else {
                reject(error);
            }
        });
    });
};

VideoInputProcessorPT.prototype.registerVideoInputProcessorProtocolTranslator = async function() {
    const self = pt;
    return new Promise((resolve, reject) => {
        let timeout = setTimeout(() => {
            reject('Timeout');
        }, TIMEOUT);

        self.client.send('protocol_translator_register', { 'name': self.name },
            function(error, response) {
                clearTimeout(timeout);
                if (!error) {
                    // Connection ok. 
                    resolve(response);
                } else {
                    reject(error);
                }
            });
    });
};

VideoInputProcessorPT.prototype.publicConfig = function() {
    // make a copy of the current config...
    const publicConfig = JSON.parse(JSON.stringify(pt.config));

    // zero out the the auth data...
    publicConfig['config']['auth'] = {};
    publicConfig['config']['mqttPassword'] = "";

    // return a public viewable config
    return publicConfig;
}

VideoInputProcessorPT.prototype.createJsonRpcParams = function(ptDeviceName,jsonrpc) {
    let params = {};
    if (jsonrpc !== undefined) {
        if (jsonrpc['config'] != undefined) {
            // its a config update
            const config_str = Buffer.from(JSON.stringify(pt.publicConfig())).toString('base64');
            params = {
                deviceId: ptDeviceName,
                objects: [{
                    objectId: VIDEO_INPUT_PROCESSOR_RPC_API_OBJECT_ID,
                    objectInstances: [{
                        objectInstanceId: 0,
                        resources: [
                            {
                                resourceId: VIDEO_INPUT_PROCESSOR_API_CONFIG_RESOURCE_ID,
                                operations: OPERATIONS.READ | OPERATIONS.WRITE,
                                type: 'string',
                                value: config_str
                            }
                        ]
                    }]
                }]
            };
        }
        else {
            // its an RPC API call response...
            const rpc_api_str = Buffer.from(JSON.stringify(jsonrpc)).toString('base64');
            const config_str = Buffer.from(JSON.stringify(pt.publicConfig())).toString('base64');
            const status_str = Buffer.from(JSON.stringify(pt.getCommandStatus())).toString('base64');
            params = {
                deviceId: ptDeviceName,
                objects: [{
                    objectId: VIDEO_INPUT_PROCESSOR_RPC_API_OBJECT_ID,
                    objectInstances: [{
                        objectInstanceId: 0,
                        resources: [
                            {
                                resourceId: VIDEO_INPUT_PROCESSOR_API_COMMAND_RESOURCE_ID,
                                operations: OPERATIONS.READ | OPERATIONS.EXECUTE,
                                type: 'string',
                                value: rpc_api_str
                            },
                            {
                                resourceId: VIDEO_INPUT_PROCESSOR_API_CONFIG_RESOURCE_ID,
                                operations: OPERATIONS.READ | OPERATIONS.WRITE,
                                type: 'string',
                                value: config_str
                            }
                        ]
                    }]
                }]
            };
        }
    }
    else {
        // empty input!  
        pt.log(LOGGING.ERROR,"WARNING: createJsonRpcParams: Empty input parameter");
    }

    return params;
}

VideoInputProcessorPT.prototype.addResource = async function() {
    const self = pt;
    return new Promise((resolve, reject) => {
        params = self.createJsonRpcParams(self.ptDeviceName,DEFAULT_JSON_RPC_COMMAND);
        let timeout = setTimeout(() => {
            reject('Timeout');
        }, TIMEOUT);

        self.client.send('device_register', params,
            function(error, response) {
                clearTimeout(timeout);
                if (!error) {
                    pt.log(LOGGING.DEBUG,'Created Video Input Processor Command/Config API');
                    resolve(response);
                } else {
                    reject(error);
                }
            });
    });
}

VideoInputProcessorPT.prototype.validatedParams = function(method,params) {
    if (method !== undefined) {
        if (SUPPORTED_COMMANDS[method] !== undefined) {
            if (params !== undefined && JSON.stringify(params) !== '[]' ) {
                const param_json = SUPPORTED_COMMANDS[method];
                if (param_json !== undefined && JSON.stringify(param_json) !== '{}') {
                    const param_list = param_json['params'];
                    if (param_list !== undefined && JSON.stringify(param_list) != '[]') {
                        // find key matches for each required parameter. Extraneous params will be ignored. 
                        for (var i = 0; i < param_list.length; i++) {
                            if (params[param_list[i]] === undefined) {
                                // missing a required parameter
                                pt.log(LOGGING.ERROR,"Invalid Parameters: Missing required parameter: " + param_list[i])
                                return false;
                            }
                        }

                        // record the retain parameter
                        if (params['retain'] !== undefined) {
                            this.config['config']['retain'] = params['retain'];
                        }
                        // if we make it this far, we are good
                        pt.log(LOGGING.DEBUG,"Parameters validated: " + JSON.stringify(params) + " Method: " + method);
                        return true;   
                    }
                }
                // any misses here will fall through to the end resulting in invalidation...
            }
            else {
                // no parameters specified (OK)
                pt.log(LOGGING.DEBUG,"No parameters specified (OK). Validated OK.");
                return true;
            }
        }
    }
    pt.log(LOGGING.ERROR,"Invalid Parameters: " + method + " Params: " + JSON.stringify(params));
    return false;
}

VideoInputProcessorPT.prototype.isSupportedMethod = function(method,params) {
    if (method !== undefined) {
        if (SUPPORTED_COMMANDS[method] !== undefined) {
            if (params !== undefined && JSON.stringify(params) !== '[]' ) {
                return pt.validatedParams(method,params);
            }
            pt.log(LOGGING.DEBUG,"Supported Method: " + method + " (no params)")
            return true;
        }
    }
    pt.log(LOGGING.ERROR,"Unsupported Method: " + method + " Params: " + params);
    return false;
}

VideoInputProcessorPT.prototype.validateCommand = function(jsonrpc) {
    if (jsonrpc !== undefined && JSON.stringify(jsonrpc) !== "{}" &&
        jsonrpc['jsonrpc'] === '2.0' && pt.isSupportedMethod(jsonrpc['method'],jsonrpc['params']) &&
        jsonrpc['id'] !== undefined) {
            pt.log(LOGGING.INFO,"Command Validated: " + JSON.stringify(jsonrpc))
            return true;
    }
    pt.log(LOGGING.ERROR,"Command NOT Validated: " + JSON.stringify(jsonrpc));
    return false;
}

VideoInputProcessorPT.prototype.createErrorReply = async function(jsonrpc,message,details) {
    let reply = {};
    reply['jsonrpc'] = "2.0";
    reply['id'] = jsonrpc['id'];
    reply['status'] = 'error';
    reply['reply'] = message;
    reply['details'] = details;
    return reply; 
}

VideoInputProcessorPT.prototype.sendResponse = async function(result) {
    if (result !== undefined) {
        // format 
        let res = {'error':result.error,'reply':result.status,'response':result.reply};
        if (result['details'] !== undefined) {
            res['details'] = result['details'];
        }
        pt.log(LOGGING.DEBUG,"sendResponse: Response: " + JSON.stringify(res));

        // Update the resource value with the result
        pt.updateResourceValue(res);
    }
}

VideoInputProcessorPT.prototype.readLocalFile = async function(filename) {
    try {
        pt.log(LOGGING.INFO,"readLocalFile: reading in local file: " + filename);
        const data = await fs.readFileSync(filename, 'utf8');
        pt.log(LOGGING.INFO,"readLocalFile: File: " + filename + " read in successfully");
        return data;
      } 
      catch (err) {
          pt.log(LOGGING.ERROR, "readLocalFile: Error reading file: " + filename + " Exception: " + err, err);
      }
      return "error";
}

VideoInputProcessorPT.prototype.readS3File = async function(s3_url) {
    // We must have previously configured our PT with appropriate config details apriori...
    if (pt.config['config']['auth']['awsAccessKeyId'] !== "" && pt.config['config']['auth']['awsSecretAccessKey'] !== "") {
        // strip off the s3:// uri...
        const s3_filename = s3_url.replace('s3://','');

        // set the region for AWS S3 support
        AWS.config.update({region: pt.config['config']['awsRegion']});

        // use the AWS S3 API to write the contents of the file to the S3 bucket
        const s3 = new AWS.S3(
                    {
                        accessKeyId: pt.config['config']['auth']['awsAccessKeyId'], 
                        secretAccessKey: pt.config['config']['auth']['awsSecretAccessKey'], 
                        Bucket:pt.config['config']['awsS3Bucket']
                    });

        // params to read file from S3 bucket
        const params = {
                        'Bucket':pt.config['config']['awsS3Bucket'], 
                        'Key': s3_filename
                       };

        // read in the file from S3
        pt.log(LOGGING.INFO,"Reading in file from S3 bucket: " + pt.config['config']['awsS3Bucket'] + " S3 filename: " + s3_filename);
        await s3.getObject(params, function(err, data) {
            if (err) {
                pt.log(LOGGING.ERROR,"readS3File: ERROR reading file. S3 Filename: " + s3_filename + " from S3: " + err);
                return "error";
            }
            else {
                pt.log(LOGGING.INFO,"readS3File: File read in successfully. S3 filename:" + s3_filename);
                return data['Body'];
            }
        });
    }
    else {
        // no credentials...
        pt.log(LOGGING.ERROR,"Error creating directory in S3 bucket: credentials not initialized. Dir: " + dir);
    }
    return "error";
}

VideoInputProcessorPT.prototype.deleteS3File = async function(s3_url) {
    // We must have previously configured our PT with appropriate config details apriori...
    if (pt.config['config']['auth']['awsAccessKeyId'] !== "" && pt.config['config']['auth']['awsSecretAccessKey'] !== "") {
        // strip off the s3:// uri...
        const s3_filename = s3_url.replace('s3://','');

        // set the region for AWS S3 support
        AWS.config.update({region: pt.config['config']['awsRegion']});

        // use the AWS S3 API to write the contents of the file to the S3 bucket
        const s3 = new AWS.S3(
                    {
                        accessKeyId: pt.config['config']['auth']['awsAccessKeyId'], 
                        secretAccessKey: pt.config['config']['auth']['awsSecretAccessKey'], 
                        Bucket:pt.config['config']['awsS3Bucket']
                    });

        // params to delete file from S3 bucket
        const params = {
                        'Bucket':pt.config['config']['awsS3Bucket'], 
                        'Key': s3_filename
                       };

        // delete file from S3
        pt.log(LOGGING.INFO,"Deleting file from S3 bucket: " + pt.config['config']['awsS3Bucket'] + " S3 filename: " + s3_filename);
        await s3.deleteObject(params, function(err, data) {
            if (err) {
                pt.log(LOGGING.ERROR,"deleteS3File: ERROR deleting file. S3 Filename: " + s3_filename + " from S3: " + err);
                return "error";
            }
            else {
                pt.log(LOGGING.INFO,"deleteS3File: File deleted successfully. S3 filename:" + s3_filename);
                return s3_filename;
            }
        });
    }
    else {
        // no credentials...
        pt.log(LOGGING.ERROR,"Error deleting file in S3 bucket: credentials not initialized. URL: " + s3_url);
    }
    return "error";
}

VideoInputProcessorPT.prototype.mkS3Dir = async function(dir) {
    // We must have previously configured our PT with appropriate config details apriori...
    if (pt.config['config']['auth']['awsAccessKeyId'] !== "" && pt.config['config']['auth']['awsSecretAccessKey'] !== "") {
        // set the region for AWS S3 support
        AWS.config.update({region: pt.config['config']['awsRegion']});

        // use the AWS S3 API to write the contents of the file to the S3 bucket
        const s3 = new AWS.S3(
                    {
                        accessKeyId: pt.config['config']['auth']['awsAccessKeyId'], 
                        secretAccessKey: pt.config['config']['auth']['awsSecretAccessKey'], 
                        Bucket:pt.config['config']['awsS3Bucket']
                    });

        // params to write the file to the S3 bucket 
        const params = {
                        'Bucket':pt.config['config']['awsS3Bucket'], 
                        'Key': dir + '/',
                        'ACL': 'public-read',
                        'Body':''
                       };

        // write the file to the S3 bucket
        pt.log(LOGGING.INFO,"Creating directory in S3 bucket: " + pt.config['config']['awsS3Bucket'] + " Dir: " + dir);
        await s3.putObject(params, function(err, data) {
            if (err) {
                pt.log(LOGGING.ERROR,"mkS3Dir: ERROR creating Directory: " + dir + " to S3: " + err);
                return "error";
            }
            else {
                pt.log(LOGGING.INFO,"mkS3Dir: Directory created successfully:" + dir);
                return dir;
            }
        });
    }
    else {
        // no credentials...
        pt.log(LOGGING.ERROR,"Error creating directory in S3 bucket: credentials not initialized. Dir: " + dir);
    }
    return "error";
}

VideoInputProcessorPT.prototype.writeToS3Bucket = async function(data,dir,filename) {
    // We must have previously configured our PT with appropriate config details apriori...
    if (pt.config['config']['auth']['awsAccessKeyId'] !== "" && pt.config['config']['auth']['awsSecretAccessKey'] !== "") {
        // constuct the fully qualified filename to write
        filename = dir + "/" + filename;

        // set the region for AWS S3 support
        AWS.config.update({region: pt.config['config']['awsRegion']});

        // use the AWS S3 API to write the contents of the file to the S3 bucket
        const s3 = new AWS.S3(
                    {
                        accessKeyId: pt.config['config']['auth']['awsAccessKeyId'], 
                        secretAccessKey: pt.config['config']['auth']['awsSecretAccessKey'], 
                        Bucket:pt.config['config']['awsS3Bucket']
                    });

        // params to write the file to the S3 bucket 
        const params = {
                        'Bucket':pt.config['config']['awsS3Bucket'], 
                        'Key':filename,
                        'Body':Buffer.from(data)
                       };

        // write the file to the S3 bucket
        pt.log(LOGGING.INFO,"Writing prediction results S3 bucket: " + pt.config['config']['awsS3Bucket'] + " File: " + filename);
        await s3.upload(params, function(err, data) {
            if (err) {
                pt.log(LOGGING.ERROR,"writeToS3Bucket: ERROR Uploading " + filename + " to S3: " + err);
                return "error";
            }
            else {
                pt.log(LOGGING.INFO,`writeToS3Bucket: File uploaded successfully. ${data.Location}`);
                return filename;
            }
        });
    }
    else {
        // no credentials...
        pt.log(LOGGING.ERROR,"Error writing file to S3 bucket: credentials not initialized. Filename: " + filename + " Dir: " + dir);
    }
    return "error";
}

VideoInputProcessorPT.prototype.startCapture = async function(mypt, jsonrpc) {
    let reply = {};
    reply['jsonrpc'] = "2.0";
    reply['id'] = jsonrpc['id'];
    reply['status'] = 'capturing';
    reply['error'] = 'none';
    const doRetain = jsonrpc['params']['retain'];
    
    if (mypt.doCapture == false) {
        try {
            // start the capture thread...
            mypt.doCapture = true;
            mypt.log(LOGGING.INFO,"Starting capture...");

            // send our initial reply
            await mypt.sendResponse(reply);

            // busy loop to capture until 
            while(mypt.doCapture == true) {
                // loop and capture "n" frames
                const timestamp = Date.now();
                const root_dir = CAPTURE_DIR + "/raw/" + timestamp;
                mypt.log(LOGGING.INFO,"Checking for existance of: " + root_dir)
                await fs.mkdirSync(root_dir, { recursive: true });
                for(var i=0;i<mypt.config['config']['numCapturesPerPrediction'];i++) {
                    // set our capture filename for each of "n" captures...
                    const base_filename = timestamp + "_" + i + "." + mypt.config['config']['cameraOptions']['filenameSuffix'];
                    const filename = root_dir + "/" +  base_filename;
                    mypt.log(LOGGING.DEBUG, "Capture will be saved to: " + filename + " Base: " + base_filename);

                    // invoke the nth capture...
                    await mypt.Webcam.capture(filename, function( err, data ) {});
                    let exists = await fs.existsSync(filename);
                    while(!exists) {
                        exists = await fs.existsSync(filename);
                    }

                    // record the capture...
                    await mypt.collection.push(base_filename);
                    
                    // if we have enough for a prediction... send to preprocessing and dispatch for prediction...
                    if (i == (mypt.config['config']['numCapturesPerPrediction'] - 1)) {
                        // create the dispatch payload
                        const payload = {};
                        payload['files'] = mypt.collection;
                        payload['timestamp'] = timestamp;
                        payload['root_dir'] = root_dir;
                        payload['base_dir'] = CAPTURE_DIR;
                        payload['retain'] = doRetain;

                        // dispatch for preprocessing and prediction...
                        mypt.collection = await mypt.dispatchAndPredict(mypt, payload);
                        await mypt.Webcam.clear();

                        // sleep for a bit...
                        mypt.log(LOGGING.INFO,"startCapture(): sleeping for " + mypt.config['config']['captureFPS'] + " ms...");
                        await sleep(mypt.config['config']['captureFPS']);

                        // take another set of pictures...
                        mypt.log(LOGGING.INFO,"startCapture():  Taking another set of pictures...");
                    }
                }
            }

            // we have exited the capture loop....
            mypt.log(LOGGING.INFO,"Capture thread has stopped. (OK)");

            // reset collector
            mypt.collection = [];
            mypt.setCommandStatus("startCapture",CMD_STATUS.IDLE);
        }
        catch (ex) {
            // no longer capturing
            mypt.doCapture = false;

            // reset collector
            mypt.collection = [];

            mypt.log(LOGGING.ERROR,"Capture caught Exception",ex);
            reply['status'] = 'error';
            reply['error'] = 'Exception: ' + ex;
            mypt.setCommandStatus("startCapture",CMD_STATUS.ERROR);

            // send our error reply
            mypt.sendResponse(reply);
        }
    }
    else {
        // already running..
        mypt.log(LOGGING.INFO,"Capture thread is already running... (OK)");

        // send our initial reply
        mypt.sendResponse(reply);
    }
}

VideoInputProcessorPT.prototype.stopCapture = async function(jsonrpc) {
    pt.log(LOGGING.INFO,"Stopping capture...");
    pt.doCapture = false;
    let reply = {};
    reply['jsonrpc'] = "2.0";
    reply['id'] = jsonrpc['id'];
    reply['status'] = 'stopped';
    reply['error'] = 'none';
    // pt.log(LOGGING.INFO,"stopCapture(): Response: " + res + " Error: " + err + " reply: " + JSON.stringify(reply));
    pt.log(LOGGING.INFO,"stopCapture(): Response: " + JSON.stringify(reply));
    pt.setCommandStatus("stopCapture",CMD_STATUS.IDLE);
    pt.sendResponse(reply);
}

VideoInputProcessorPT.prototype.configUpdatedResponse = async function(jsonrpc) {
    let reply = {};
    reply['jsonrpc'] = "2.0";
    reply['id'] = jsonrpc['id'];
    reply['status'] = 'ok';
    reply['error'] = 'none';
    reply['reply'] = 'config updated';
    pt.log(LOGGING.INFO,"configUpdatedResponse reply: " + JSON.stringify(reply));

    // send the response
    pt.sendResponse(reply)
}

VideoInputProcessorPT.prototype.getCommandStatus = function() {
    return pt.commandStatus;
}

VideoInputProcessorPT.prototype.setCommandStatus = function(command,status) {
    pt.commandStatus[command] = status;
    pt.log(LOGGING.INFO,"Command Status: " + JSON.stringify(pt.commandStatus));
    return pt.commandStatus;
}

VideoInputProcessorPT.prototype.invokeCommand = async function(jsonrpc) {
    let result = {};
    let in_error = false;
    try {
        pt.setCommandStatus(jsonrpc['method'],CMD_STATUS.RUNNING);
        switch(jsonrpc['method']) {
            case('startCapture'):
                // startCapture method
                pt.sendResponse({'error':'none','status':'ok','reply':'request dispatched', 'details': "startCapture"});
                await pt.startCapture(pt, jsonrpc);
                break;
            case('stopCapture'):
                // stopCapture method
                pt.sendResponse({'error':'none','status':'ok','reply':'request dispatched', 'details': "stopCapture"});
                await pt.stopCapture(jsonrpc);
                break;
            default:
                // unsupported method
                in_error = true;
                result = await pt.createErrorReply(jsonrpc,"Unsupported Method",jsonrpc['method']);
                pt.setCommandStatus(jsonrpc['method'],CMD_STATUS.ERROR);

                // send a response (typically an error response)
                pt.sendResponse(result);
        }
    }
    catch(ex) {
        pt.setCommandStatus(jsonrpc['method'],CMD_STATUS.ERROR);
        pt.log(LOGGING.ERROR,"Exception caught in invokeCommand", ex);
        const [, lineno, colno] = ex.stack.match(/(\d+):(\d+)/);
        pt.log(LOGGING.ERROR, 'Line:' + lineno + ' Column: ' + colno);
        result = await pt.createErrorReply(jsonrpc,"EX: " + ex.message,jsonrpc['method']);

        // send a response (typically an error response)
        pt.sendResponse(result);
    }
}

VideoInputProcessorPT.prototype.updateConfiguration = async function(new_config) {
    // update the configuration components...
    await Object.keys(new_config).forEach(function(key) {
        pt.config['config'][key] = new_config[key];
        });

    // resync mqtt connection
    pt.updateMQTTConfiguration(pt);

    // resync the camera configuration
    pt.setCameraOptions(pt.config['config']['videoInputDev']);
    pt.Webcam = NodeWebcam.create(pt.config['config']['cameraOptions']);
}

VideoInputProcessorPT.prototype.isConfigCommand = function(jsonrpc) {
    if (jsonrpc !== undefined && jsonrpc['config'] !== undefined) {
        return true;
    }
    return false;
}

VideoInputProcessorPT.prototype.processCommand = async function(jsonrpc) {
    if (pt.isConfigCommand(jsonrpc)) {
        // update our configuration
        await pt.updateConfiguration(jsonrpc['config']);
        
        // send a config update response
        pt.configUpdatedResponse(jsonrpc);
    }
    else if (pt.validateCommand(jsonrpc)) {
        // command has valid form - so execute it
        await pt.invokeCommand(jsonrpc);
    }
    else {
        // invalid command type given... so respond with an error response
        const result = await pt.createErrorReply(jsonrpc,"Invalid Command",jsonrpc['method']);
        
        // send a response (typically an error result)
        pt.sendResponse(result);
    }
}

VideoInputProcessorPT.prototype.updateResourceValue = async function(json) {
    const self = pt;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject('Timeout');
        }, TIMEOUT);
        const params = self.createJsonRpcParams(self.ptDeviceName,json);
        self.client.send('write', params,
            function(error, response) {
                clearTimeout(timeout);
                if (!error) {
                    resolve(response);
                } else {
                    reject(error);
                }
            });
    });
}

VideoInputProcessorPT.prototype.runJsonRpcCommandProcessor = async function() {
    let result = {};
    pt.client.expose('write', async (params, response) => {
        let valueBuff = new Buffer.from(params.value, 'base64');
        let jsonrpc_str = valueBuff.toString('utf-8');
        let resourcePath = params.uri.objectId + '/' + params.uri.objectInstanceId + '/' + params.uri.resourceId;
        if (params.operation === OPERATIONS.EXECUTE || params.operation === OPERATIONS.WRITE) {
            try {
                // Execute the RPC request with Sagemaker API...
                const jsonrpc = JSON.parse(jsonrpc_str);
                pt.processCommand(jsonrpc);
                response(/* no error */ null, /* success */ 'ok');
                await pt.connect();
            } catch (ex) {
                // did not receive an execute command - so ignore
                pt.log(LOGGING.ERROR,'Exception while processing command: ' + jsonrpc_str, ex);
                result = {"error":"Exception while processing command: " + ex,"reply":"error"};

                // Update the resource value with the result
                response(result, null);
                await pt.connect();
            }
        }
        else {
            // did not receive an execute command - so ignore
            pt.log(LOGGING.INFO,'Not an execute or config update command. Ignoring request... (OK)');
            result = {"error":"Not an Execute/Config Update command","reply":"error"};

            // Update the resource value with the result
            response(result, null);
            await pt.connect();
        }
    });
}

VideoInputProcessorPT.prototype.dispatchAndPredict = async function(mypt, json) {
    try {
        if (mypt.mqttClient !== undefined && mypt.mqttConnected == true) {
            // create the publish shape in NCHW format
            const publish_shape = [];
            publish_shape.push(json['files'].length);
            publish_shape.push(this.config['config']['shape']['depth']);
            publish_shape.push(this.config['config']['shape']['height']);
            publish_shape.push(this.config['config']['shape']['width']);

            // prepare the publish payload
            const publish_data = {};
            publish_data['timestamp'] = json['timestamp'];
            publish_data['files'] = json['files'];
            publish_data['shape'] = publish_shape;
            publish_data['model'] = this.config['config']['model'];
            publish_data['retain'] = json['retain'];
            publish_data['root_dir'] = json['root_dir'];
            publish_data['base_dir'] = json['base_dir'];
            publish_data['local_dir'] = LOCAL_DIR;

            // send the raw image data over MQTT to the preprocessor... 
            mypt.log(LOGGING.INFO,"Dispatching captured raw images over MQTT for preprocessing...");
            await mypt.mqttClient.publish(MQTT_VIDEO_INPUT_TOPIC, JSON.stringify(publish_data));
        }
        else {
            mypt.log(LOGGING.INFO, "MQTT not connected. Unable to dispatch captured files to preprocessor.");
            if (mypt.mqttClient == undefined) {
                mypt.log(LOGGING.INFO,"MQTT HANDLE IS NULL"); 
            }
            else {
                mypt.log(LOGGING.INFO,"MQTT connection status is FALSE");
            }
        }
    }
    catch (ex) {
        mypt.log(LOGGING.ERROR, "Exception in dispatchAndPredict: " + ex, ex);
    }
    return [];
}

VideoInputProcessorPT.prototype.cleanupFiles = async function(root_dir) {
    try {
        pt.log(LOGGING.INFO,"Cleaning up captures. Removing directory: " + root_dir);
        await fs.rmdirSync(root_dir, { recursive: true });
    } 
    catch (ex) {
        pt.log(LOGGING.ERROR, "Exception cleaning up captures: RootDir: " + root_dir + " Exception: " + ex, ex);
    }

    // return an emptied list...
    return [];
}

VideoInputProcessorPT.prototype.parseS3OutputFilename = function(output_tensor) {
    // break apart the URL
    const key = 's3://';
    const base = output_tensor.replace(key,'');
    const parsed = base.split('/');

    // reconstruct
    const s3_parsed = {};
    s3_parsed['filename'] = parsed[2];
    s3_parsed['s3_root_dir'] = parsed[0];
    s3_parsed['s3_full_dir'] = parsed[0] + "/" + parsed[1];
    return s3_parsed;
}

VideoInputProcessorPT.prototype.preserveFiles = async function(json_obj) {
    // get key items...
    const timestamp = json_obj['timestamp'];
    const root_dir = json_obj['root_dir']; 
    const doRetain = json_obj['retain'];
    const files = json_obj['files'];
    const tensor_file = json_obj['tensor_filename'];
    const output_tensor = json_obj['output_tensor'];

    // Parse the S3 output tensor filename
    const s3_parsed = pt.parseS3OutputFilename(output_tensor);
    const out_tensorfile = s3_parsed['filename'];
    const out_s3_root_dir = s3_parsed['s3_root_dir'];

    // make the S3 subdirectory for "timestamp"
    const base_dir = out_s3_root_dir + "/capture/" + timestamp;
    const result = await pt.mkS3Dir(base_dir);

    // copy the target files to the base_dir
    if (result !== undefined) {
        // upload the original image files
        for(var i=0;i<files.length;++i) {
            const local_filename = root_dir + "/" + files[i];
            await pt.writeToS3Bucket(await pt.readLocalFile(local_filename),base_dir,files[i]);
        }

        // upload the input_tensor file
        await pt.writeToS3Bucket(await pt.readLocalFile(tensor_file),base_dir,"input-" + timestamp + ".tensor");

        // upload the output_tensor
        await pt.writeToS3Bucket(await pt.readS3File(output_tensor),base_dir,"output-" + timestamp + ".tensor");
    }
    else {
        // unable to upload files - directory create has failed
        pt.log(LOGGING.ERROR,"Unable to preserve files - unable to create S3 directory: " + base_dir);
    }
}

VideoInputProcessorPT.prototype.processMQTTCommand = async function(buffer) {
    // messages come in as Buffer type...
    const json_str = buffer.toString('utf8');

    // parse the string
    try {
        // parse the JSON string
        const json_obj = JSON.parse(json_str);

        // decode the command and act
        switch(json_obj['command']) {
            case "clean":
                // get key items...
                const timestamp = json_obj['timestamp'];
                const root_dir = json_obj['root_dir']; 
                const doRetain = json_obj['retain'];
                const tensor_file = json_obj['tensor_filename'];
                const output_tensor = json_obj['output_tensor'];

                // preserve files if asked
                if (doRetain == true) {
                    pt.log(LOGGING.INFO, "Preserving files: " + JSON.stringify(json_obj));
                    await pt.preserveFiles(json_obj);

                    // clean up the output tensor
                    pt.log(LOGGING.INFO,"Output tensor now preserved. Deleting original: " + output_tensor);
                    await pt.deleteS3File(output_tensor);

                    // final log
                    pt.log(LOGGING.INFO,"Retaining captured images in: " + root_dir + " with timestamp: " + timestamp);
                }
                
                // purging raw images...
                pt.log(LOGGING.INFO,"Cleaning out captured raw images with timestamp: " + timestamp + " Root dir: " + root_dir);
                await pt.cleanupFiles(root_dir);
                pt.log(LOGGING.INFO,"Cleaned out captured raw images: " + root_dir + ". OK.");
                
                // clean up the output tensor
                // pt.log(LOGGING.INFO,"Output tensor now preserved. Deleting original: " + output_tensor);
                // await pt.deleteS3File(output_tensor);

                // remove any processed tensor files
                pt.log(LOGGING.INFO,"Removing Input Tensor File: " + tensor_file);
                await fs.rmSync(tensor_file);
                break;
            default:
                // ignore unsupported/handled commands
                pt.log(LOGGING.DEBUG, "Command: " + json_obj['command'] + " ignored (no processor) - OK.");
                break;
        }
    }
    catch(ex) {
        // error in processing mqtt command
        pt.log(LOGGING.ERROR, "Exception in processMQTTCommand: " + ex + ". Ignoring command.", ex);
    }
}

VideoInputProcessorPT.prototype.connectToMQTTBroker = async function(mypt) {
    if (mypt.mqttConnected == false) {
        try {
            // connect to MQTT broker...
            mypt.log(LOGGING.INFO,"Connecting to internal MQTT broker: " + mypt.mqttUrl + "...");
            const client = mqtt.connect(mypt.mqttUrl, mypt.mqttOptions);
            client.on('connect', function () {
                // note that we are connected
                mypt.mqttConnected = true;
                mypt.mqttClient = client;
                mypt.log(LOGGING.INFO, "Connected to MQTT: " + mypt.mqttUrl);

                // subscribe to the command channel
                client.subscribe(MQTT_COMMAND_TOPIC, function (err) {
                    if (err) {
                        mypt.log(LOGGING.ERROR,"Error in subscribing to the command channel: " + err);
                    }
                });
            });
            client.on('disconnect', function () {
                // we are no longer connected
                mypt.mqttConnected = false;
                mypt.mqttClient = undefined;
                mypt.log(LOGGING.INFO, "Disconnnected from MQTT: " + mypt.mqttUrl);
            });
            client.on('message', async function (topic, buffer) {
                if (topic !== undefined && topic == MQTT_COMMAND_TOPIC) {
                    // process received command
                    mypt.processMQTTCommand(buffer);
                }
            });
        }
        catch(ex) {
            // unable to connect to mqtt broker
            mypt.log(LOGGING.ERROR, "Unable to connect to mqtt broker: " + ex, ex);
            mypt.mqttConnected = false;
            mypt.mqttClient = undefined;
        }
    }
};

(async function() {
    try {
        // create the VideoInputProcessor PT using the environment configuration
        pt = new VideoInputProcessorPT(process.env.SAPT_LOG_LEVEL,
                                       process.env.SAPT_AWS_ACCESS_KEY_ID,
                                       process.env.SAPT_AWS_SECRET_ACCESS_KEY,
                                       process.env.SAPT_AWS_S3_BUCKET,
                                       process.env.SAPT_AWS_S3_VIDEO_CAPTURE_DIR,
                                       process.env.SAPT_AWS_REGION,
                                       process.env.SAPT_PT_DEVICE_NAME);

        // Set SIGINT handle
        process.on('SIGINT', sigintHandler = async function() {
            pt.log(LOGGING.INFO,"Caught SIGINT. Disconnecting and exiting...");
            process.exit(1);
        });
       
        // Connect to Edge
        await pt.connect();
        pt.log(LOGGING.INFO,'Connected to Edge');

        // Register with Edge as a PT
        let response = await pt.registerVideoInputProcessorProtocolTranslator();
        pt.log(LOGGING.INFO,'Registered as Protocol Translator. Response: ' + response);

        // Add the VideoInputProcessor Json RPC Resource
        response = await pt.addResource();
        pt.log(LOGGING.INFO,'Added VideoInputProcessor RPC API Resource. Response: ' + response);

        // Connect to MQTT broker
        await pt.connectToMQTTBroker(pt);

        // Run Json RPC Command Processor
        await pt.runJsonRpcCommandProcessor();
    } catch (ex) {
        console.error('Main: Exception Caught: ', ex);
        if (ex.stack !== undefined) {
            const [, lineno, colno] = ex.stack.match(/(\d+):(\d+)/);
            console.error('Line:' + lineno + ' Column: ' + colno);
        }
        process.exit(1);
    }
})();
