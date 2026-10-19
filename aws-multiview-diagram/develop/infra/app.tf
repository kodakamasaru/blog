# --- ALB -> ECS(api) -> RDS ---

resource "aws_lb" "public" {
  name                       = "${local.name}-alb"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = [aws_subnet.public_a.id, aws_subnet.public_c.id]
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 60
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.name}-api-tg"
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = "arn:aws:acm:ap-northeast-1:123456789012:certificate/dummy"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}-api"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  task_role_arn            = aws_iam_role.api_task.arn
  execution_role_arn       = aws_iam_role.api_exec.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "api"
    image        = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/photo-api:1.4.2"
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "UPLOAD_BUCKET", value = aws_s3_bucket.uploads.bucket },
      { name = "THUMBNAIL_BUCKET", value = aws_s3_bucket.thumbnails.bucket },
      { name = "PHOTOS_TABLE", value = aws_dynamodb_table.photos.name },
      { name = "DB_HOST", value = aws_db_instance.main.address },
    ]
    secrets = [
      { name = "DB_PASSWORD", valueFrom = aws_secretsmanager_secret.db.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = "ap-northeast-1"
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                              = "${local.name}-api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = 2
  launch_type                       = "FARGATE"
  platform_version                  = "1.4.0"
  health_check_grace_period_seconds = 30
  enable_execute_command            = true
  network_configuration {
    subnets          = [aws_subnet.app_a.id, aws_subnet.app_c.id]
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = [aws_subnet.db_a.id, aws_subnet.db_c.id]
}

resource "aws_db_instance" "main" {
  identifier                   = "${local.name}-db"
  engine                       = "postgres"
  engine_version               = "16.4"
  instance_class               = "db.t4g.medium"
  allocated_storage            = 50
  max_allocated_storage        = 200
  storage_type                 = "gp3"
  storage_encrypted            = true
  multi_az                     = true
  db_name                      = "photo"
  username                     = "app"
  manage_master_user_password  = true
  backup_retention_period      = 7
  deletion_protection          = true
  performance_insights_enabled = true
  db_subnet_group_name         = aws_db_subnet_group.main.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-db-final"
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${local.name}/db-password"
  recovery_window_in_days = 7
}
