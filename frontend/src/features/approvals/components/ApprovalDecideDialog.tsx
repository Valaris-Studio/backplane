// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Textarea } from "@/components/ui/textarea";
import { RichTextRenderer } from "@/components/shared/RichTextRenderer";
import { formatDateTime } from "@/lib/format";
import { useDecideApproval } from "../hooks/useApprovals";
import type { Approval } from "@/types/approval";

interface ApprovalDecideDialogProps {
  slug: string;
  approval: Approval | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ApprovalDecideDialog({
  slug,
  approval,
  open,
  onOpenChange,
}: ApprovalDecideDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const decide = useDecideApproval(slug);

  const rawDetails = approval?.action_payload?.details;
  const approvalDetails = typeof rawDetails === "string" ? rawDetails : "";

  // Decided approvals open read-only: the request + the decision that was made,
  // with no action buttons. Only `pending` is actionable.
  const isDecided = !!approval && approval.status !== "pending";

  function handleDecide(decision: "approved" | "rejected") {
    if (!approval) return;
    decide.mutate(
      { approvalId: approval.id, decision, reason },
      {
        onSuccess: () => {
          setReason("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isDecided
              ? t("approvals.decideDialog.viewTitle")
              : t("approvals.decideDialog.title")}
          </DialogTitle>
        </DialogHeader>

        {approval ? (
          <RichTextRenderer
            content={approval.action_description}
            className="text-muted-foreground"
          />
        ) : null}

        {approvalDetails ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {t("approvals.decideDialog.details")}
            </p>
            <RichTextRenderer
              content={approvalDetails}
              className="text-muted-foreground"
            />
          </div>
        ) : null}

        {isDecided && approval ? (
          <>
            <div className="space-y-1 rounded-[var(--radius-md)] border border-border/60 bg-muted/30 p-3">
              <p className="text-sm font-medium text-foreground">
                {t("approvals.decideDialog.decision")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(`approvals.status.${approval.status}`)}
                {approval.decided_by_name
                  ? ` · ${t("approvals.decideDialog.decidedBy", { name: approval.decided_by_name })}`
                  : ""}
                {approval.decided_at
                  ? ` · ${formatDateTime(approval.decided_at)}`
                  : ""}
              </p>
              {approval.decision_reason ? (
                <RichTextRenderer
                  content={approval.decision_reason}
                  className="text-muted-foreground"
                />
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <label
                htmlFor="approval-reason"
                className="text-sm font-medium text-foreground"
              >
                {t("approvals.decideDialog.reason")}
              </label>
              <Textarea
                id="approval-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("approvals.decideDialog.reasonPlaceholder")}
                rows={3}
              />
            </div>

            <DialogFooter>
              <RichTooltip i18nKey="approvals.decide.reject">
                <Button
                  variant="destructive"
                  onClick={() => handleDecide("rejected")}
                  disabled={decide.isPending}
                >
                  {t("approvals.actions.reject")}
                </Button>
              </RichTooltip>
              <RichTooltip i18nKey="approvals.decide.approve">
                <Button
                  className="bg-success text-success-foreground hover:bg-success/90"
                  onClick={() => handleDecide("approved")}
                  disabled={decide.isPending}
                >
                  {t("approvals.actions.approve")}
                </Button>
              </RichTooltip>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
