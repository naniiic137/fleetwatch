{{/* Chart name, truncated to 63 chars (DNS label limit). */}}
{{- define "fleetwatch.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name. */}}
{{- define "fleetwatch.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "fleetwatch.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "fleetwatch.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fleetwatch.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "fleetwatch.labels" -}}
helm.sh/chart: {{ include "fleetwatch.chart" . }}
{{ include "fleetwatch.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: fleetwatch
{{- end }}

{{- define "fleetwatch.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "fleetwatch.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "fleetwatch.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* Alertmanager: own name and selector, so the probe Service never selects its pods. */}}
{{- define "fleetwatch.alertmanager.fullname" -}}
{{- printf "%s-alertmanager" (include "fleetwatch.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "fleetwatch.alertmanager.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-alertmanager" (include "fleetwatch.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: alertmanager
{{- end }}

{{- define "fleetwatch.alertmanager.labels" -}}
helm.sh/chart: {{ include "fleetwatch.chart" . }}
{{ include "fleetwatch.alertmanager.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.alertmanager.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: fleetwatch
{{- end }}

{{/* alertmanager.yml: alertmanager.config when set, else files/alertmanager.yml (same as compose). */}}
{{- define "fleetwatch.alertmanager.config" -}}
{{- if .Values.alertmanager.config }}
{{- .Values.alertmanager.config }}
{{- else }}
{{- .Files.Get "files/alertmanager.yml" }}
{{- end }}
{{- end }}
