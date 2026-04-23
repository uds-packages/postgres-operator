{{/*
Copyright 2024 Defense Unicorns
SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Defense-Unicorns-Commercial
*/}}

{{/*
Network Polcies for Postgres Operator, specifically related to the addition of Connection Pooler.
*/}}
{{- define "uds-postgres.ingressRules" -}}
{{- $selector := .selector -}}
{{- if kindIs "slice" .ingress -}}
{{- range .ingress }}
- direction: Ingress
  selector:
    {{- $selector | toYaml | nindent 4 }}
  {{- . | toYaml | nindent 2 }}
{{- end }}
{{- else }}
- direction: Ingress
  selector:
    {{- $selector | toYaml | nindent 4 }}
  {{- .ingress | toYaml | nindent 2 }}
{{- end }}
{{- end -}}
