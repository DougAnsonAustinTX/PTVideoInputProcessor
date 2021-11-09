#!/bin/sh

HOME=/usr/src/app

if [ -f ${HOME}/logs/ip.log ]; then
  mv ${HOME}/logs/ip.log ${HOME}/logs/ip.log-$$
fi

#
# Start our Image Preprocessor
#
cd ${HOME}/ptImagePreprocessor
python3.7 ./image_preprocessor.py > ${HOME}/logs/ip.log 2>&1 &
cd ${HOME}