#
# ----------------------------------------------------------------------------
# Copyright 2020 Pelion Ltd.
#
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ----------------------------------------------------------------------------
#

# General OS
import sys
import signal
import json
import argparse

# Logging
import logging

# Asyncio support
import asyncio

# Paho MQTT
import paho.mqtt.client as mqtt

# Tensorflow
import numpy as np 
import tensorflow as tf
from tensorflow.keras.preprocessing.image import load_img, img_to_array

# Service Name
SERVICE_NAME = 'ImagePreprocessorService'

# MQTT Topics
RAW_INPUT_TOPIC         = "rawinput"
PROCESSED_OUTPUT_TOPIC  = "processed"

# Create logger
logger = logging.getLogger(SERVICE_NAME)

# Signal handler to exit the service...
def exit_signal(signum, frame):
    logger.info(SERVICE_NAME + ": Closing down on signal: {signum}".format(signum=signum))
    sys.exit(0)

# Our Image Preprocessor Service as a Thread
class ImagePreprocessorService():
    # Constructor
    def __init__(self):
        self.name = SERVICE_NAME
        self.client = mqtt.Client()
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.on_subscribe = self.on_subscribe
        
    # OnSubscribe
    def on_subscribe(self, obj, mid, granted_qos):
        logger.info("Subscribed to: " + str(mid) + " " + str(granted_qos))
        
    # OnConnect
    def on_connect(self, client, userdata, flags, rc):
        logger.info("Connected with result code "+str(rc) + ". Subscribing to: " + RAW_INPUT_TOPIC + "...")
        client.subscribe(RAW_INPUT_TOPIC)
        
    # OnMessage
    def on_message(self, client, userdata, msg):
        # Convert the payload to JSON...
        msg_json_str = msg.payload.decode("utf-8");
        msg_json = json.loads(msg_json_str)
        
        # Debug
        logger.info("Topic: " + msg.topic + " Payload: " + json.dumps(msg_json))
        
        # Process the input command
        self.process_command(msg_json)
        
    # SendMessage
    def send_message(self, topic, msg_str):
        infot = self.client.publish(topic, msg_str)
        infot.wait_for_publish()
            
    # Keras50 preprocessing
    def keras50_preprocess(self, json):
        logger.info("Keras50 Preprocessing: " + json.dumps(json))
        self.send_message(PROCESSED_OUTPUT_TOPIC,json['timestamp'])
        
    # Raw preprocessing
    def raw_preprocess(self, json):
        logger.info("Raw Preprocessing: " + json.dumps(json))
        
    # Process the input command
    def process_command(self, json):
        model = json['model']
        if json['model'] == 'keras50':
            # preprocessing images for keras50... 
            self.keras50_preprocess(json)
        else:
            # non-preprocessing - just passing raw input...
            logger.info("WARNING: Model " + model + " has no registered preprocessor function... input files not changed (OK)")
            self.raw_preprocess(json)
        
    # Service main loop
    async def main_loop(self,name,loop,mqtt_hostname,mqtt_port):
        self.mloop = loop
        self.name = name
        
        # Connect to MQTT Broker
        self.client.connect(mqtt_hostname, mqtt_port, 60)
        
        # Enter processing loop
        self.client.loop_forever()
        
# Main 
async def main(mLoop):
    # Initialize signals
    signal.signal(signal.SIGTERM, exit_signal)
    
    # Initialize logging level
    logging.basicConfig(level=logging.INFO, filemode='w', format='[%(levelname)s] %(name)s - %(message)s')
    
    # Parse any arguments we have passed
    parser = argparse.ArgumentParser(
        description='Pelion Image Preprocessor Service',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument('-n', '--name', dest="name", help='service name', type=str, default=SERVICE_NAME)
    args = parser.parse_args()
    
    # Create the service
    service = ImagePreprocessorService()
    logger.info("Pelion Image Preprocessor Service: Starting...")
    
    # Run the service
    await service.main_loop(args.name,mLoop,"127.0.0.1",1883)
    
    # Exited the service loop
    logger.error("Service's main loop has exited. Exiting...");
    exit(1)

# Main Call
if __name__ == "__main__":
    mLoop = asyncio.get_event_loop()
    mLoop.run_until_complete(main(mLoop))
    mLoop.close()