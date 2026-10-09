output "release_name" {
  description = "Name of the Helm release."
  value       = helm_release.fleetwatch.name
}

output "namespace" {
  description = "Namespace the release was installed into."
  value       = helm_release.fleetwatch.namespace
}

output "release_status" {
  description = "Helm release status (deployed, failed, ...)."
  value       = helm_release.fleetwatch.status
}

output "chart_version" {
  description = "Version of the deployed chart."
  value       = helm_release.fleetwatch.version
}

output "service_name" {
  description = "Name of the Kubernetes Service in front of the probe."
  value       = local.service_name
}

output "metrics_url" {
  description = "In-cluster URL Prometheus can scrape."
  value       = "http://${local.service_name}.${var.namespace}.svc.cluster.local:8080/metrics"
}

output "port_forward_command" {
  description = "Command to reach the probe from your machine."
  value       = "kubectl -n ${var.namespace} port-forward svc/${local.service_name} 8080:8080"
}
