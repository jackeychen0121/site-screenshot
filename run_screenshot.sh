#!/bin/bash

while true; do
    nohup node screenshot.js &
    NODE_PID=$!
    wait $NODE_PID
    echo "screenshot.js crashed. Restarting..."
    sleep 2
done

