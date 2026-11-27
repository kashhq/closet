import { t } from './i18n';
import { type AgentLabel, agentName } from './write-origin';

/**
 * Who made a row, where an agent did (#822; the label is already the
 * viewer's, resolved in SQL by `agentLabelSql`, so this only words it): a
 * calendar entry, a trip's outfit, an outfit, a garment. The one badge of
 * every surface; `data-agent` is what the specs read. Rows a person made
 * pass null and get nothing. The name truncates inside the badge (a token's
 * name is the owner's free text) so a row at phone width never overflows;
 * assistive tech reads "Made by <name>" instead of the bare name.
 */
export function AgentBadge({
  agent,
  byAgent = false,
}: {
  agent: AgentLabel | null;
  /**
   * The row is one of the agent's: `suggested_at` (a garment) or `proposed_at`
   * (an outfit), the explicit marker, never a token on the row (#821). Its
   * own "From the agent" says who made it, so it gets no second badge; a
   * surface that can show an agent row states its marker here, so the rule is
   * decided in this one place (calendar entries and trip outfits are never
   * The agent's).
   */
  byAgent?: boolean;
}) {
  if (agent === null || byAgent) return null;
  const name = agentName(agent);
  return (
    <span
      class="badge badge-soft badge-secondary badge-xs min-w-0 max-w-40 shrink"
      data-agent={name}
    >
      <span class="sr-only">{t('agent.MADE_BY', { name })}</span>
      <span class="truncate" aria-hidden="true">
        {name}
      </span>
    </span>
  );
}
