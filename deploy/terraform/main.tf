# Deploys the FleetWatch Helm chart into a Kubernetes cluster.
#
#   terraform init
#   terraform apply -var 'kube_context=kind-fleetwatch'

provider "helm" {
  kubernetes {
    config_path    = pathexpand(var.kubeconfig_path)
    config_context = var.kube_context
  }
}

locals {
  chart_path   = var.chart_path != "" ? var.chart_path : "${path.module}/../helm/fleetwatch"
  service_name = strcontains(var.release_name, "fleetwatch") ? var.release_name : "${var.release_name}-fleetwatch"

  helm_values = {
    image = {
      repository = var.image_repository
      tag        = var.image_tag
      pullPolicy = var.image_pull_policy
    }
    replicaCount = var.replicas
    config = {
      intervalSeconds = var.interval_seconds
      timeoutSeconds  = var.timeout_seconds
      logLevel        = var.log_level
    }
    targets = [
      for t in var.targets : {
        name           = t.name
        url            = t.url
        expect_status  = t.expect_status
        expect_keyword = t.expect_keyword
      }
    ]
    networkPolicy = {
      enabled = var.network_policy_enabled
    }
    serviceMonitor = {
      enabled = var.service_monitor_enabled
    }
    prometheusRule = {
      enabled = var.prometheus_rule_enabled
    }
    alertmanager = {
      enabled        = var.alertmanager_enabled
      config         = var.alertmanager_config
      existingSecret = var.alertmanager_existing_secret
      networkPolicy = {
        enabled = var.network_policy_enabled
      }
    }
  }
}

resource "helm_release" "fleetwatch" {
  name             = var.release_name
  chart            = local.chart_path
  namespace        = var.namespace
  create_namespace = var.create_namespace
  atomic           = true
  wait             = true
  timeout          = var.timeout_seconds_install
  values           = [yamlencode(local.helm_values)]
}
