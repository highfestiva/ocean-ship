#!/bin/bash

cat index.html | sed 's|./src/||g' > dist/index.html
cp -R css/ objects/ textures/ favicon.ico dist/
