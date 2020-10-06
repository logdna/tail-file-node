#!/usr/bin/env node

'use strict'

const {promises: fs} = require('fs')
const path = require('path')
const TEMPLATE_FILE = 'commit.template'

async function main() {
  // Set up the default template, in case it's not overridden
  let template = path.join(__dirname, TEMPLATE_FILE)

  // A custom template name has been provided
  if (process.argv[2]) {
    template = path.join(__dirname, '..', process.argv[2])
  }

  const commitParams = process.env.HUSKY_GIT_PARAMS.split(' ')
  const commitEditMsg = commitParams[0]
  const commitVia = commitParams[1]

  // If they aren't doing a plain commit via the editor, then don't touch it
  if (commitVia !== 'template') {
    return
  }

  let templateContent

  try {
    templateContent = await fs.readFile(template, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      const error = new Error(
        'Commit template not found.  Either provide a file, or create the '
          + 'default in tools/commit.template'
      )
      error.code = 'ENOENT'
      throw error
    }
    throw err
  }

  await fs.writeFile(commitEditMsg, templateContent, 'utf8')
}

main().catch((err) => {
  process.nextTick(() => {
    console.error(err)
    process.exit(1)
  })
})
