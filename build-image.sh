#!/bin/sh

if [ -z "${MACHINE}" ]; then
    export MACHINE=`uname -m`
fi
# export EDGE_AGENT_VERSION="1.20210305"
export EDGE_AGENT_VERSION="1.20210820.e20fa3a"
export IMAGE_TAG="videoinputprocessorimage-${MACHINE}"

#
# Bring in the configured environment
#
. ./ptVideoInputProcessor/.env

#
# Build the image
#
echo "Building Video Input Processor PT Image for Machine Type: "${MACHINE}"..."
echo 
echo docker build -t ${IMAGE_TAG} -f Dockerfile-${MACHINE} .
docker build -t ${IMAGE_TAG} -f Dockerfile-${MACHINE} .

#
# Tag for Docker Hub
#
echo "Tagging image..."
docker tag ${IMAGE_TAG}:latest danson/${IMAGE_TAG}:latest

#
# Publish
#
# docker login --username=danson
echo docker push danson/${IMAGE_TAG}:latest
