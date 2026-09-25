# Four trust boundaries:
#
#   internet --80--> alb --3000--> api --5432--> rds <--5432-- backend
#
# Security groups are stateful: replies to an allowed connection are always
# permitted, so every rule below describes who may *open* a connection.
# Rules are separate resources (one flow each) rather than inline blocks,
# which keeps each flow individually readable in the plan and lets the
# api/backend <-> rds references point at each other without a cycle.
#
# Terraform removes the allow-all egress rule AWS adds to every new security
# group, so a group with no rule resources here really has no rules.

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Future ALB: HTTP from the internet, forwards only to the API"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-alb" }
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "Future API tasks: port 3000 from the ALB only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-api" }
}

resource "aws_security_group" "backend" {
  name        = "${var.name}-backend"
  description = "Future worker, coordinator and migration tasks: no inbound"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-backend" }
}

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds"
  description = "Future RDS: PostgreSQL from the api and backend groups only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-rds" }
}

# --- ALB ---------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_internet" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere (no TLS yet)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

# The ALB only needs to reach its targets (traffic and health checks).
resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward and health-check to API tasks"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.api.id
}

# --- API tasks ---------------------------------------------------------------
#
# The source is the ALB's *security group*, not a CIDR: only network
# interfaces that are members of the alb group match, so even a task with a
# public IP rejects port 3000 from anywhere else, including other hosts
# inside the VPC.

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "App traffic and health checks from the ALB"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

# Egress for ECS tasks (api and backend alike): HTTPS anywhere, PostgreSQL to
# the rds group only. With no NAT Gateway and no VPC endpoints, tasks reach
# ECR (image pull), S3 (image layers) and CloudWatch Logs over their public
# IPs; those services' addresses are large and change, so 443 to 0.0.0.0/0
# is the practical rule. The application itself makes no outbound calls
# besides PostgreSQL. DNS to the VPC resolver is not filtered by security
# groups and needs no rule.

resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  description       = "AWS APIs (ECR, S3, CloudWatch Logs) over HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "api_to_rds" {
  security_group_id            = aws_security_group.api.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

# --- Backend tasks (worker, coordinator, migrations) --------------------------
#
# No ingress rules at all: these processes serve nothing. They coordinate
# only through PostgreSQL, over connections they open themselves.

resource "aws_vpc_security_group_egress_rule" "backend_https" {
  security_group_id = aws_security_group.backend.id
  description       = "AWS APIs (ECR, S3, CloudWatch Logs) over HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "backend_to_rds" {
  security_group_id            = aws_security_group.backend.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

# --- RDS ---------------------------------------------------------------------
#
# Group references rather than the VPC CIDR: "anything in 10.0.0.0/16" would
# include the ALB and any future resource; the real trust boundary is "tasks
# running our code". No egress rules: the database never opens connections,
# and replies to inbound connections are allowed statefully.

resource "aws_vpc_security_group_ingress_rule" "rds_from_api" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from API tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_backend" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from worker, coordinator and migration tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.backend.id
}

# --- VPC default security group ----------------------------------------------
#
# Every VPC gets a default group that allows all traffic between its members
# and all egress. Nothing here uses it; taking it over with no rules means a
# resource accidentally launched without an explicit group gets no access
# instead of open access. This adopts the existing group; it creates nothing.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-default-unused" }
}
