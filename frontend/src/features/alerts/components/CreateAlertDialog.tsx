// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateAlert } from "../hooks/useAlerts";

const METRICS = [
  "health_score",
  "stale_card_count",
  "overdue_card_count",
  "agent_efficiency",
  "reversion_rate",
  "handoff_friction",
  "cost_usd_7d",
  "cost_usd_30d",
] as const;

const OPERATORS = [
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "eq", label: "=" },
] as const;

interface CreateAlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  boardId?: string;
}

export function CreateAlertDialog({
  open,
  onOpenChange,
  slug,
  boardId,
}: CreateAlertDialogProps) {
  const { t } = useTranslation();
  const createAlert = useCreateAlert(slug, boardId);
  const [name, setName] = useState("");
  const [metric, setMetric] = useState("");
  const [operator, setOperator] = useState("");
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createAlert.mutate(
      {
        name,
        metric,
        operator,
        value: parseFloat(value),
        board_id: boardId,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setName("");
          setMetric("");
          setOperator("");
          setValue("");
        },
      },
    );
  };

  const isValid = name && metric && operator && value && !isNaN(parseFloat(value));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("alerts.createTitle")}</DialogTitle>
          <DialogDescription>{t("alerts.createDescription")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              {t("alerts.name")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("alerts.namePlaceholder")}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                {t("alerts.metric")}
              </label>
              <Select value={metric} onValueChange={setMetric}>
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder={t("alerts.selectMetric")} />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`alerts.metrics.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                {t("alerts.operator")}
              </label>
              <Select value={operator} onValueChange={setOperator}>
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder={t("alerts.selectOperator")} />
                </SelectTrigger>
                <SelectContent>
                  {OPERATORS.map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                {t("alerts.value")}
              </label>
              <Input
                type="number"
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!isValid || createAlert.isPending}
            >
              {createAlert.isPending
                ? t("common.saving")
                : t("alerts.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
