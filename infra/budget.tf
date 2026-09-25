# Monthly cost budget with email alerts, scoped to this project's resources.
# This is an alarm, not a cap: AWS Budgets never stops or deletes resources
# (no budget actions are configured), and billing data lags by hours, so
# spend can pass a threshold before the email arrives.
#
# Scope is resources tagged Project = var.name (applied to everything here
# by the provider's default_tags), not the whole account, which also holds
# unrelated projects. AWS Budgets can only filter on a user-defined tag once
# that tag is activated as a cost allocation tag in Billing, and a tag can
# only be activated after AWS has seen it on at least one resource. Hence
# the sequence, controlled by enable_budget:
#
#   1. apply with enable_budget = false: tagged resources exist, no budget;
#   2. activate the "Project" cost allocation tag in Billing (manual; the
#      tag can take up to 24 hours to appear there after first use);
#   3. apply with enable_budget = true and a real budget_alert_email.
#
# Spend from untagged resources (for example data transfer, or anything
# created outside this configuration) is not counted by this budget.
resource "aws_budgets_budget" "monthly" {
  count = var.enable_budget ? 1 : 0

  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = "50"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Budgets' tag filter format is "user:<key>$<value>". join() rather than
  # string interpolation because "$${" in an HCL string is an escape for a
  # literal "${", not a "$" followed by an interpolation.
  cost_filter {
    name   = "TagKeyValue"
    values = [join("$", ["user:Project", var.name])]
  }

  # Early warning: actual spend this month passed $20.
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 20
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  # AWS forecasts the month will end above $50: act before it happens.
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    threshold                  = 50
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  # Actual spend this month passed $50.
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 50
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
