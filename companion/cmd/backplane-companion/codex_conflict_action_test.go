// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

func TestRequiredActionSeparatesUnconfirmedOTelSettingsFromRestart(t *testing.T) {
	for _, language := range []struct {
		locale, unconfirmed, unchanged, reload, stillUnconfirmed, quit string
		forbidden                                                      []string
	}{
		{"en_US.UTF-8", "cannot confirm", "left those settings unchanged", "reload its settings", "does not confirm", "quit and reopen Codex", []string{"another OpenTelemetry endpoint", "sessions are not captured", "Remove that exporter"}},
		{"es_ES.UTF-8", "no puede confirmar", "sin cambios", "recargar su configuración", "no confirma", "cierra y vuelve a abrir Codex", []string{"otro endpoint", "sesiones de Codex no se capturan", "Elimina ese exportador"}},
		{"pt_BR.UTF-8", "não pode confirmar", "sem alterações", "recarregar suas configurações", "não confirma", "feche e reabra o Codex", []string{"outro endpoint", "sessões do Codex não são capturadas", "Remova esse exportador"}},
	} {
		t.Run(language.locale, func(t *testing.T) {
			a := &app{getenv: func(key string) string {
				if key == "LANG" {
					return language.locale
				}
				return ""
			}}
			for _, restart := range []string{"", agent.ProblemRestartRequired, agent.ProblemDaemonRestartRequired} {
				t.Run("conflict_"+restart, func(t *testing.T) {
					problems := []string{agent.ProblemConflictExistingOTel}
					if restart != "" {
						problems = append(problems, restart)
					}
					action := a.requiredAction(agent.IntegrationStatus{State: agent.Broken, Problems: problems})
					for _, want := range []string{"OpenTelemetry", "config.toml", language.unconfirmed, language.unchanged} {
						if !strings.Contains(action, want) {
							t.Errorf("missing %q in %q", want, action)
						}
					}
					for _, forbidden := range language.forbidden {
						if strings.Contains(action, forbidden) {
							t.Errorf("unsupported claim %q in %q", forbidden, action)
						}
					}
					if restart != "" {
						for _, want := range []string{language.reload, language.stillUnconfirmed} {
							if !strings.Contains(action, want) {
								t.Errorf("combined condition missing %q in %q", want, action)
							}
						}
						want := language.quit
						if restart == agent.ProblemDaemonRestartRequired {
							want = "codex app-server daemon restart"
						}
						if !strings.Contains(action, want) {
							t.Errorf("combined restart lost user action %q: %q", want, action)
						}
					} else if strings.Contains(action, language.reload) || strings.Contains(action, "codex app-server daemon restart") {
						t.Errorf("conflict alone invented a restart: %q", action)
					}
				})
			}
			for _, restart := range []string{agent.ProblemRestartRequired, agent.ProblemDaemonRestartRequired} {
				action := a.requiredAction(agent.IntegrationStatus{State: agent.Installed, Problems: []string{restart}})
				if action != message(restart, language.locale) || strings.Contains(action, "OpenTelemetry") {
					t.Errorf("standalone restart guidance changed: %q", action)
				}
			}
		})
	}
}
