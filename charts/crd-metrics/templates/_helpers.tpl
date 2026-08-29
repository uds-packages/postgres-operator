# postgres-crd-metrics.fullname
{{- define "postgres-crd-metrics.fullname" -}}
{{- printf "%s-%s" .Release.Name "postgres-crd-metrics" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

# postgres-crd-metrics.labels
{{- define "postgres-crd-metrics.labels" -}}
app.kubernetes.io/name: postgres-crd-metrics
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
{{- end -}}

# label selectors
{{- define "postgres-crd-metrics.selectorLabels" -}}
app.kubernetes.io/name: postgres-crd-metrics
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
