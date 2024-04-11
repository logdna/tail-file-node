library 'magic-butler-catalogue'

def PROJECT_NAME = "tail-file-node"
def REPO = "logdna/${PROJECT_NAME}"
def TRIGGER_PATTERN = ".*@logdnabot.*"
def DEFAULT_BRANCH = 'main'
def CURRENT_BRANCH = [env.CHANGE_BRANCH, env.BRANCH_NAME]?.find{branch -> branch != null}

pipeline {
  agent {
    node {
      label 'ec2-fleet'
      customWorkspace "${PROJECT_NAME}-${BUILD_NUMBER}"
    }
  }

  options {
    timestamps()
    ansiColor 'xterm'
  }

  triggers {
    issueCommentTrigger(TRIGGER_PATTERN)
  }

  environment {
    GITHUB_TOKEN = credentials('github-api-token')
    NPM_CONFIG_CACHE = '.npm'
    NPM_CONFIG_USERCONFIG = '.npmrc'
    SPAWN_WRAP_SHIM_ROOT = '.npm'
  }

  stages {
    stage('Validate PR Source') {
      when {
        expression { env.CHANGE_FORK }
        not {
          triggeredBy 'issueCommentCause'
        }
      }
      steps {
        error("A maintainer needs to approve this PR for CI by commenting")
      }
    }

    stage('Test Suite') {
      matrix {
        axes {
          axis {
            name 'NODE_VERSION'
            values '18', '20'
          }
        }

        agent {
          docker {
            label 'ec2-fleet'
            image "us.gcr.io/logdna-k8s/node:${NODE_VERSION}"
          }
        }

        stages {
          stage('Test') {
            steps {
              sh "mkdir -p ${NPM_CONFIG_CACHE}"
              sh 'mkdir -p coverage'
              sh 'npm install'
              sh 'npm run test:ci'
            }

            post {
              always {
                junit checksName: 'Test Results', testResults: 'coverage/*.xml'

                publishHTML target: [
                  allowMissing: false,
                  alwaysLinkToLastBuild: false,
                  keepAll: true,
                  reportDir: 'coverage/lcov-report',
                  reportFiles: 'index.html',
                  reportName: "coverage-node-v${NODE_VERSION}"
                ]
              }
            }
          }
        }
      }
    }

    stage('Test Release') {
      when {
        not {
          branch DEFAULT_BRANCH
        }
      }

      agent {
        docker {
          label 'ec2-fleet'
          image "us.gcr.io/logdna-k8s/node:18-ci"
          customWorkspace "${PROJECT_NAME}-${BUILD_NUMBER}"
        }
      }

      environment {
        GIT_BRANCH = "${CURRENT_BRANCH}"
        BRANCH_NAME = "${CURRENT_BRANCH}"
        CHANGE_ID = ""
        NPM_TOKEN = credentials('npm-publish-token')
      }

      steps {
        script {
          sh "mkdir -p ${NPM_CONFIG_CACHE}"
          sh 'npm install'
          sh 'npm run commitlint'
          if (!(env.CHANGE_FORK ==~ /.+/)) {
            sh "npm run release:dry"
          }
        }
      }
    }

    stage('Release') {
      when {
        branch DEFAULT_BRANCH
        not {
          changelog '\\[skip ci\\]'
        }
      }

      agent {
        docker {
          label 'ec2-fleet'
          image "us.gcr.io/logdna-k8s/node:18-ci"
          customWorkspace "${PROJECT_NAME}-${BUILD_NUMBER}"
        }
      }

      environment {
        GIT_BRANCH = "${CURRENT_BRANCH}"
        BRANCH_NAME = "${CURRENT_BRANCH}"
        CHANGE_ID = ""
        NPM_TOKEN = credentials('npm-publish-token')
      }

      steps {
        script {
          sh "mkdir -p ${NPM_CONFIG_CACHE}"
          sh 'npm install'
          sh 'npm run release'
        }
      }
    }
  }
}
