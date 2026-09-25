# One VPC, two AZs, two tiers:
#
#   public-a      10.0.0.0/24   AZ[0]   route 0.0.0.0/0 -> Internet Gateway
#   public-b      10.0.1.0/24   AZ[1]   route 0.0.0.0/0 -> Internet Gateway
#   private-db-a  10.0.10.0/24  AZ[0]   local VPC routes only
#   private-db-b  10.0.11.0/24  AZ[1]   local VPC routes only
#
# Subnets are written out individually rather than generated with
# count/cidrsubnet so each address range is readable in the code and plan.

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  # Both are needed for the VPC's Amazon-provided DNS to resolve AWS service
  # hostnames (ECR, CloudWatch Logs) and the future RDS endpoint name.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

# The VPC's only path to and from the internet. It is what the public route
# table's default route points at; a subnet without that route cannot use it.
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = var.name }
}

# --- Public subnets (future ALB and Fargate task ENIs) ----------------------
#
# map_public_ip_on_launch stays false. Fargate decides per ECS service via
# assignPublicIp, independent of this subnet flag, and the ALB's addresses
# are managed by AWS. Leaving it off means nothing else launched here
# receives a (billable) public IPv4 address by accident.

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.0.0/24"
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-a", Tier = "public" }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = local.azs[1]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-b", Tier = "public" }
}

# --- Private DB subnets (future RDS) ----------------------------------------

resource "aws_subnet" "private_db_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.10.0/24"
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-private-db-a", Tier = "private-db" }
}

resource "aws_subnet" "private_db_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.11.0/24"
  availability_zone       = local.azs[1]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-private-db-b", Tier = "private-db" }
}

# --- Routing -----------------------------------------------------------------
#
# Every route table implicitly contains "10.0.0.0/16 -> local", so all four
# subnets can reach each other. What makes a subnet public is only the extra
# 0.0.0.0/0 -> IGW route in the table it is associated with.

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# Deliberately has no routes beyond the implicit local one: the database
# tier has no path to or from the internet at all, regardless of security
# groups. Explicitly associated (rather than falling back to the VPC's main
# route table) so a route later added to the main table can't silently
# reach these subnets.
resource "aws_route_table" "private_db" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-private-db" }
}

resource "aws_route_table_association" "private_db_a" {
  subnet_id      = aws_subnet.private_db_a.id
  route_table_id = aws_route_table.private_db.id
}

resource "aws_route_table_association" "private_db_b" {
  subnet_id      = aws_subnet.private_db_b.id
  route_table_id = aws_route_table.private_db.id
}
