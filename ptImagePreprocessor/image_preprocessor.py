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
import os
import signal
import json
import argparse
import base64
import traceback

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
from tensorflow.keras.applications.resnet50 import preprocess_input

# Service Name
SERVICE_NAME = 'ImagePreprocessorService'

# MQTT Topics
RAW_INPUT_TOPIC = "rawinput"
COMMAND_TOPIC   = "command"       

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
        self.client.on_publish = self.on_publish
        
    # OnPublish
    def on_publish(self, client, obj, mid):
        logger.info("Published: " + str(mid))
        
    # OnSubscribe
    def on_subscribe(self, client, obj, mid, granted_qos):
        logger.info("Subscribed: " + str(mid) + " " + str(granted_qos))
        
    # OnConnect
    def on_connect(self, client, userdata, flags, rc):
        logger.info("Connected with result code "+str(rc) + ". Subscribing to: " + RAW_INPUT_TOPIC + "...")
        client.subscribe(RAW_INPUT_TOPIC)
        
    # OnMessage
    def on_message(self, client, userdata, msg):
        # Convert the payload to JSON...
        msg_json_str = msg.payload.decode("utf-8");
        msg_json = json.loads(msg_json_str)
        
        # Process the input command
        self.process_command(msg_json)
        
    # SendMessage
    def send_message(self, topic, msg_str):
        infot = self.client.publish(topic, msg_str)
        infot.wait_for_publish()
            
    # Read in a batch of images
    def read_image_batch(self, img_paths, img_height, img_width):
        img_list = [load_img(img_path, target_size=(img_height, img_width)) for img_path in img_paths if os.path.isfile(img_path)]
        array_list =  np.array([img_to_array(img) for img in img_list])
        return {"img":img_list, "array":array_list}
    
    # Keras50 preprocessing
    def keras50_preprocess(self, json_obj):
        # Debug
        # logger.info("Keras50 Input: " + json.dumps(json_obj))
        
        try:
            # import the images
            shape = json_obj['shape'];
            files = json_obj['files'];
            file_list = [];
            for i in range(0, len(files)):
                file_list.append(json_obj['root_dir'] + '/' + files[i])
        
            # LoadImages
            loaded_images = self.read_image_batch(file_list,shape[2],shape[3])
            
            # Preprocess images for Keras50...
            preprocessed_images_list = preprocess_input(loaded_images['array'])
            
            # Debug
            # logger.info("Keras50: Input shape: " + str(preprocessed_images_list.shape))
            # logger.info("Keras50: Input dtype: " + str(preprocessed_images_list.dtype))
            # logger.info("Keras50: Input data length number of images: " + str(len(preprocessed_images_list)))
            
            # Transpose to make the shape Neo-compatible for Keras50
            preprocessed_images_list = tf.transpose(preprocessed_images_list,[0, 3, 1, 2])

            # Neo-compatible input tensor shape now!
            # logger.info("Keras50: Neo transposed Input shape: " + str(preprocessed_images_list.shape))
            # logger.info("Keras50: Neo transposed Input dtype: " + str(preprocessed_images_list.dtype))
            # logger.info("Keras50: Neo transposed Input data length number of images: " + str(len(preprocessed_images_list)))
            
            # Write the input tensor out to local file...
            input_data_filename = json_obj['local_dir'] + "/data/" + str(json_obj['timestamp']) + ".np"
            input_data_json = {}
            input_data_json ['b64_data'] = base64.b64encode(preprocessed_images_list.numpy().data.tobytes()).decode('ascii')
            with open(input_data_filename, 'w') as f:
                f.write(json.dumps(input_data_json))
                f.close()
            
            # Build out the predict() command
            cmd = {}
            cmd['command'] = "predict"
            cmd['tensor_filename'] = input_data_filename
            cmd['timestamp'] = json_obj['timestamp']
            cmd['root_dir'] = json_obj['root_dir']
            cmd['model'] = json_obj['model'];
            cmd['retain'] = json_obj['retain']
            cmd['files'] = json_obj['files']
            cmd['root_dir'] = json_obj['root_dir']
            cmd['base_dir'] = json_obj['base_dir']
            cmd['shape'] = json_obj['shape']
            cmd['num_images'] = len(preprocessed_images_list)
            
            # Publish to MQTT
            logger.info("Publishing for prediction(): " + json.dumps(cmd) + " Topic: " + COMMAND_TOPIC + " TensorFile: " + input_data_filename)
            self.client.publish(COMMAND_TOPIC,json.dumps(cmd))
        except Exception as e:
            logger.error("Caught Exception in keras50_preprocess(): " + str(e))
            logger.error(traceback.format_exc())     
        
    # Raw preprocessing
    def raw_preprocess(self, json):
        logger.info("Raw Preprocessing: " + json.dumps(json))
        
    # Process the input command
    def process_command(self, json):
        model = json['model']
        if "keras50" in model:
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