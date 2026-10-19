# 図の生成用に plan を取るだけなので、ダミーの認証情報で AWS API を呼ばずに plan できるようにしている
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = "ap-northeast-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

locals {
  name = "photo-share"
  azs  = ["ap-northeast-1a", "ap-northeast-1c"]
}
