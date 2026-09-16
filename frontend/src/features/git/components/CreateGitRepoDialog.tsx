// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Github, HelpCircle } from "lucide-react";
import { useCreateGitRepo } from "../api/use-git-repos";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from "@/components/ui/textarea";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { useGitConnections } from "@/features/integrations/api/use-git-connections";
import { RepositoryPickerDialog } from "@/features/integrations/components/RepositoryPickerDialog";
import type { GitConnectionRepository, GitProvider } from "@/types/git";

const PROVIDER_VALUES: GitProvider[] = [
  "github",
  "gitlab",
  "gitea",
  "bitbucket",
  "other",
];

interface CreateGitRepoDialogProps {
  slug: string;
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateGitRepoDialog({
  slug,
  boardId,
  open,
  onOpenChange,
}: CreateGitRepoDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<GitProvider>("github");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [description, setDescription] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerConnectionId, setPickerConnectionId] = useState<string | null>(
    null,
  );
  // The connection the new repo will be BOUND to. Set when a repo is picked
  // through a connection — that account is by construction one that can reach
  // the repo, so it is the right default credential.
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const createGitRepo = useCreateGitRepo(slug, boardId);
  const connectionsQuery = useGitConnections(slug);
  // PATs make gitlab/gitea connections real, so the offer follows the provider
  // the operator selected rather than assuming github.
  const matchingConnections =
    connectionsQuery.data?.filter((c) => c.provider === provider) ?? [];

  function openPicker(pickedConnectionId: string) {
    setPickerConnectionId(pickedConnectionId);
    setPickerOpen(true);
  }

  function handlePickRepo(repo: GitConnectionRepository) {
    // Strip the trailing `.git` so the URL matches what users would paste from
    // the GitHub UI (the OAuth API returns the .git form).
    const cleanedUrl = repo.clone_url_https.replace(/\.git$/, "");
    setName(repo.full_name.split("/").pop() ?? repo.full_name);
    setUrl(cleanedUrl);
    setProvider(repo.provider);
    setDefaultBranch(repo.default_branch || "main");
    setConnectionId(pickerConnectionId);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    createGitRepo.mutate(
      {
        name: name.trim(),
        url: url.trim(),
        provider,
        default_branch: defaultBranch.trim() || "main",
        description: description.trim() || undefined,
        ...(connectionId ? { connection_id: connectionId } : {}),
      },
      {
        onSuccess: () => {
          setName("");
          setUrl("");
          setProvider("github");
          setDefaultBranch("main");
          setDescription("");
          setConnectionId(null);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("gitRepos.createTitle")}</DialogTitle>
            <DialogDescription>{t("gitRepos.subtitle")}</DialogDescription>
          </DialogHeader>

          {matchingConnections.length > 0 ? (
            <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-primary/30 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                {provider === "github" ? (
                  <Github className="mt-0.5 h-5 w-5 text-primary" />
                ) : (
                  <GitBranch className="mt-0.5 h-5 w-5 text-primary" />
                )}
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-foreground">
                    {t("gitRepos.pickFromConnectionTitle")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("gitRepos.pickFromConnectionSubtitle")}
                  </p>
                </div>
              </div>
              {matchingConnections.length === 1 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openPicker(matchingConnections[0]!.id)}
                >
                  {t("integrations.pickRepository")}
                </Button>
              ) : (
                <Select value="" onValueChange={(v) => openPicker(v)}>
                  <SelectTrigger
                    className="sm:w-64"
                    aria-label={t("gitRepos.pickConnectionPlaceholder")}
                  >
                    <SelectValue
                      placeholder={t("gitRepos.pickConnectionPlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {matchingConnections.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.account_login}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("gitRepos.namePlaceholder")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("gitRepos.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("gitRepos.urlPlaceholder")}</label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("gitRepos.urlPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium">
                {t("gitRepos.providerPlaceholder")}
                <RichTooltip i18nKey="workspace.git.provider" side="right">
                  <HelpCircle
                    aria-label={t("gitRepos.providerPlaceholder")}
                    className="h-3.5 w-3.5 text-muted-foreground"
                  />
                </RichTooltip>
              </label>
              <Select value={provider} onValueChange={(v) => setProvider(v as GitProvider)}>
                <SelectTrigger aria-label={t("gitRepos.providerPlaceholder")}>
                  <SelectValue placeholder={t("gitRepos.providerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_VALUES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`gitRepos.providers.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("gitRepos.branchPlaceholder")}</label>
              <Input
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder={t("gitRepos.branchPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("common.descriptionOptional")}</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("common.descriptionOptional")}
                rows={3}
              />
            </div>
          </div>

          <div className="flex justify-end border-t border-border/70 pt-5">
            <Button type="submit" disabled={!name.trim() || !url.trim()}>
              {t("gitRepos.addRepo")}
            </Button>
          </div>
        </form>
      </DialogContent>

      {pickerConnectionId ? (
        <RepositoryPickerDialog
          slug={slug}
          connectionId={pickerConnectionId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={handlePickRepo}
        />
      ) : null}
    </Dialog>
  );
}
