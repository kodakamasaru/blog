# --- アップロードされた画像のサムネイル生成: S3 -> SQS -> Lambda -> DynamoDB ---

resource "aws_s3_bucket" "uploads" {
  bucket = "${local.name}-uploads"
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "thumbnails" {
  bucket = "${local.name}-thumbnails"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "thumbnails" {
  bucket = aws_s3_bucket.thumbnails.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "thumbnails" {
  bucket                  = aws_s3_bucket.thumbnails.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "thumbnails" {
  bucket = aws_s3_bucket.thumbnails.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_sqs_queue" "uploaded_dlq" {
  name                      = "${local.name}-uploaded-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "uploaded" {
  name                       = "${local.name}-uploaded"
  visibility_timeout_seconds = 360
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.uploaded_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_s3_bucket_notification" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  queue {
    queue_arn     = aws_sqs_queue.uploaded.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "originals/"
  }
}

resource "aws_dynamodb_table" "photos" {
  name         = "${local.name}-photos"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "photo_id"
  attribute {
    name = "photo_id"
    type = "S"
  }
  point_in_time_recovery {
    enabled = true
  }
  server_side_encryption {
    enabled = true
  }
  deletion_protection_enabled = true
}

resource "aws_lambda_function" "thumbnail" {
  function_name = "${local.name}-thumbnail"
  role          = aws_iam_role.thumbnail.arn
  runtime       = "python3.12"
  handler       = "app.handler"
  filename      = "thumbnail.zip"
  architectures = ["arm64"]
  memory_size   = 1024
  timeout       = 60
  tracing_config {
    mode = "Active"
  }
  environment {
    variables = {
      SOURCE_BUCKET = aws_s3_bucket.uploads.bucket
      DEST_BUCKET   = aws_s3_bucket.thumbnails.bucket
      PHOTOS_TABLE  = aws_dynamodb_table.photos.name
    }
  }
}

resource "aws_lambda_event_source_mapping" "uploaded" {
  event_source_arn                   = aws_sqs_queue.uploaded.arn
  function_name                      = aws_lambda_function.thumbnail.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 20
  }
}
