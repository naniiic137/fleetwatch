variable "kubeconfig_path" {
  description = "Path to the kubeconfig file used by the helm provider."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "kubeconfig context to deploy into (for example kind-fleetwatch). Null uses the current context."
  type        = string
  default     = null
}

variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "fleetwatch"
}

variable "namespace" {
  description = "Namespace to install the release into."
  type        = string
  default     = "fleetwatch"
}

variable "create_namespace" {
  description = "Create the namespace if it does not exist."
  type        = bool
  default     = true
}

variable "chart_path" {
  description = "Path to the chart. Empty uses the chart in this repository (../helm/fleetwatch)."
  type        = string
  default     = ""
}

variable "image_repository" {
  description = "Container image repository of the probe."
  type        = string
  default     = "ghcr.io/naniiic137/fleetwatch"
}

variable "image_tag" {
  description = "Image tag. Empty uses the chart's appVersion."
  type        = string
  default     = ""
}

variable "image_pull_policy" {
  description = "Kubernetes imagePullPolicy for the probe container."
  type        = string
  default     = "IfNotPresent"

  validation {
    condition     = contains(["Always", "IfNotPresent", "Never"], var.image_pull_policy)
    error_message = "image_pull_policy must be Always, IfNotPresent or Never."
  }
}

variable "replicas" {
  description = "Number of probe replicas."
  type        = number
  default     = 1
}

variable "interval_seconds" {
  description = "Seconds between probe rounds."
  type        = number
  default     = 30

  validation {
    condition     = var.interval_seconds >= 1
    error_message = "interval_seconds must be at least 1."
  }
}

variable "timeout_seconds" {
  description = "Per-request timeout of a check, in seconds."
  type        = number
  default     = 10

  validation {
    condition     = var.timeout_seconds > 0
    error_message = "timeout_seconds must be greater than 0."
  }
}

variable "log_level" {
  description = "Probe log level."
  type        = string
  default     = "INFO"

  validation {
    condition     = contains(["DEBUG", "INFO", "WARNING", "ERROR"], var.log_level)
    error_message = "log_level must be DEBUG, INFO, WARNING or ERROR."
  }
}

variable "targets" {
  description = "Sites to check."
  type = list(object({
    name           = string
    url            = string
    expect_status  = optional(number, 200)
    expect_keyword = optional(string, "")
  }))
  default = [
    { name = "portfolio", url = "https://www.hamzabenismail.cloud-ip.cc", expect_keyword = "Hamza Ben Ismail" },
    { name = "chkobba", url = "https://chkooba.pages.dev", expect_keyword = "Chkobba" },
    { name = "kalak", url = "https://kalak-aar.pages.dev", expect_keyword = "Kalak" },
    { name = "fog-chess", url = "https://fog-chess-erb.pages.dev", expect_keyword = "Fog Chess" },
    { name = "custom-checkers", url = "https://custom-checkers.pages.dev", expect_keyword = "Custom Checkers" },
    { name = "chess-cipher", url = "https://chesscipher.pages.dev", expect_keyword = "Chess Cipher" },
    { name = "cipher-chat", url = "https://cipher-chat.pages.dev", expect_keyword = "CipherChat" },
    { name = "jobfit-ai", url = "https://jobfit-ai-hbi.pages.dev", expect_keyword = "JobFit AI" },
    { name = "readme-glow", url = "https://readme-glow.pages.dev", expect_keyword = "ReadmeGlow" },
    { name = "picopulse", url = "https://picopulse.pages.dev", expect_keyword = "PicoPulse" },
  ]

  validation {
    condition     = length(var.targets) > 0 && alltrue([for t in var.targets : can(regex("^https?://", t.url))])
    error_message = "targets must be a non-empty list of http(s) URLs."
  }
}

variable "network_policy_enabled" {
  description = "Create the NetworkPolicy (ingress on 8080, egress DNS + 80/443 only)."
  type        = bool
  default     = true
}

variable "service_monitor_enabled" {
  description = "Create a ServiceMonitor (needs the Prometheus Operator CRDs)."
  type        = bool
  default     = false
}

variable "timeout_seconds_install" {
  description = "Seconds Helm waits for the release to become ready."
  type        = number
  default     = 300
}
