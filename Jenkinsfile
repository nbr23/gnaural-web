pipeline {
    agent any
    options {
        disableConcurrentBuilds()
    }
    stages {
        stage('Checkout'){
            steps {
                checkout scm
            }
        }
        stage('Test') {
            steps {
                sh """
                    docker build --target test .
                    """
            }
        }
        stage('Prep buildx') {
            when { branch 'master' }
            steps {
                script {
                    env.BUILDX_BUILDER = getBuildxBuilder();
                }
            }
        }
        stage('Dockerhub login') {
            when { branch 'master' }
            steps {
                withCredentials([usernamePassword(credentialsId: 'dockerhub', usernameVariable: 'DOCKERHUB_CREDENTIALS_USR', passwordVariable: 'DOCKERHUB_CREDENTIALS_PSW')]) {
                    sh 'docker login -u $DOCKERHUB_CREDENTIALS_USR -p "$DOCKERHUB_CREDENTIALS_PSW"'
                }
            }
        }
        stage('Build Docker Image') {
            when { branch 'master' }
            steps {
                sh """
                    docker buildx build --pull --builder \$BUILDX_BUILDER --platform linux/arm64,linux/amd64 --target prod --build-arg GIT_SHA=`git rev-parse --short HEAD` -t nbr23/gnaural-web:latest -t nbr23/gnaural-web:`git rev-parse --short HEAD` --push .
                    """
            }
        }
        stage('Sync github repo') {
            when { branch 'master' }
            steps {
                ghSync()
            }
        }
    }
}
