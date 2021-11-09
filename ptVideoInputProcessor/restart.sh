#!/bin/sh

rm video-input-processor.js ; vi video-input-processor.js 
PID=`ps -ef | grep node | grep -v grep | awk '{print $2}'`
/bin/kill -SIGHUP ${PID}
tail -f ../logs/pt.log