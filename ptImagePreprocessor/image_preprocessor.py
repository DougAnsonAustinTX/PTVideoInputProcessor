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

import asyncio
from contextlib2 import AsyncExitStack, asynccontextmanager
from random import randrange
from asyncio_mqtt import Client, MqttError

# Core imports for the notebook
import numpy as np 
import tensorflow as tf
import time
import os
import json

# ResNet50 helpers used specifically with our selected pre-trained model
from tensorflow.keras.applications.resnet50 import preprocess_input

async def run_image_preprocessor():
    async with AsyncExitStack() as stack:
        # Keep track of the asyncio tasks that we create, so that
        # we can cancel them on exit
        tasks = set()
        stack.push_async_callback(cancel_tasks, tasks)

        # Connect to the MQTT broker
        client = Client("127.0.0.1")
        await stack.enter_async_context(client)

        # You can create any number of topic filters
        topic_filters = (
            "rawinput",
        )
        for topic_filter in topic_filters:
            # Log all messages that matches the filter
            manager = client.filtered_messages(topic_filter)
            messages = await stack.enter_async_context(manager)
            template = f'topic:{topic_filter}, payload:{{}}'
            task = asyncio.create_task(log_messages(messages, template))
            tasks.add(task)

        # Messages that doesn't match a filter will get logged here
        messages = await stack.enter_async_context(client.unfiltered_messages())
        task = asyncio.create_task(log_messages(messages, "[unfiltered] {}"))
        tasks.add(task)
        
        # Subscribe to topic(s)
        # 🤔 Note that we subscribe *after* starting the message
        # loggers. Otherwise, we may miss retained messages.
        await client.subscribe("rawinput")

        # Publish a random value to each of these topics
        #topics = (
        #    "predict",
        #)
        #task = asyncio.create_task(post_to_topics(client, topics))
        #tasks.add(task)

        # Wait for everything to complete (or fail due to, e.g., network
        # errors)
        await asyncio.gather(*tasks)

async def post_to_topics(client, topics):
    while True:
        for topic in topics:
            message = randrange(100)
            print(f'topic={topic} message={message}')
            await client.publish(topic, message, qos=1)
            await asyncio.sleep(2)

async def log_messages(messages, template):
    async for message in messages:
        # 🤔 Note that we assume that the message paylod is an
        # UTF8-encoded string (hence the `bytes.decode` call).
        print(template.format(message.payload.decode()))

async def cancel_tasks(tasks):
    for task in tasks:
        if task.done():
            continue
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

async def main():
    # Run the advanced_example indefinitely. Reconnect automatically
    # if the connection is lost.
    reconnect_interval = 3  # [seconds]
    while True:
        try:
            await run_image_preprocessor()
        except MqttError as error:
            print(f'Error "{error}". Reconnecting in {reconnect_interval} seconds.')
        finally:
            await asyncio.sleep(reconnect_interval)


futures = [main()]
loop = asyncio.get_event_loop()
loop.run_until_complete(asyncio.wait(futures))