#!/bin/sh

if [ -d ./ptVideoInputProcessor ]; then
    cd ./ptVideoInputProcessor
    if [ -x ./install-local.sh ]; then
        ./install-local.sh
    else 
	echo "No install script found. Unable to install PT"
    fi
    cd ..
else
   echo "Video Input Processor PT directory not found. Unable to install PT"
fi
