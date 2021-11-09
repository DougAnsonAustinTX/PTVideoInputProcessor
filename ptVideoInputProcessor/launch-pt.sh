#!/bin/sh

if [ -f ./video-input-processor.js ]; then
    node video-input-processor.js
else
    echo "Unable to launch PT - file not found"
fi
