#!/bin/bash

export PATH="./node_modules/.bin:$PATH"

mkdir -p coverage

npm run test

code=$?

# tap-mocha-reporter is buggy and does not include all test results. Use tap-xunit,
# however it has a bug with subtests as well.  @isaacs has offered a solution
# by flattening: https://github.com/aghassemi/tap-xunit/issues/23#issuecomment-520480836

cat coverage/.tap-output | tap-parser -t -f | tap-xunit > coverage/test.xml

exit $code
