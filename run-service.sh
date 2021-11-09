#!/bin/sh

#
# Home
#
export HOME="/usr/src/app"

#
# Bring in the configuration
#
. ./ptVideoInputProcessor/.env

#
# Roll logs
#
roll_logs() {
    if [ -f ${HOME}/logs/pt.log ]; then
        mv ${HOME}/logs/pt.log ${HOME}/logs/pt.log-$$
    fi
}

#
# Run Image Preprocessor
#
run_image_preprocessor() {
    if [ -x ${HOME}/run-image-preprocessor.sh ]; then
        echo "Starting Image Preprocessor..."
        ${HOME}/run-image-preprocessor.sh &
    else 
        echo "Not starting Image Preprocessor: Launch script not executable/present."
    fi
}

#
# Run PT
#
run_pt() {
    if [ -d ${HOME}/ptVideoInputProcessor ]; then
        cd ${HOME}/ptVideoInputProcessor 
        if [ -f ./video-input-processor.js ]; then
            echo "Running Video Input Processor PT..." > ${HOME}/logs/pt.log 2>&1
            while :
            do
                node ./video-input-processor.js >> ${HOME}/logs/pt.log 2>&1
                if [ -f ${HOME}/.no_respawn ]; then
                    echo "Video Input Processor PT has died... sleeping(no-respawn)..." >> ${HOME}/logs/pt.log 2>&1
                    while true; do
                        sleep 10000
                    done
                else
                    echo "Video Input Processor PT has died... restarting..." >> ${HOME}/logs/pt.log 2>&1
                    sleep 5
                fi
            done
        else
            echo "Unable to find Video Input Processor PT JS... sleeping..." > ${HOME}/logs/pt.log 2>&1
        fi
    else
        echo "Unable to Run Video Input Processor PT... file not found. Sleeping..." > ${HOME}/logs/pt.log 2>&1
    fi
}

#
# Main
#
main() {
    # Roll Logs
    roll_logs $*

    # Run Image Processor
    run_image_preprocessor $*

    # Run Edge PT forever
    run_pt $*

    #
    # Should never be reached
    #
    while true; do
        sleep 10000
    done
}

main $*