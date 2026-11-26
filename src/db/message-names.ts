/**
 * The names a message carries for display and search (`sender_name`, `conversation_name`)
 * are copies of contact, participant and conversation names. These build the SQL that
 * derives them, shared by the projector and the search-index drain so both resolve a
 * message's names the same way.
 *
 * Plain strings rather than ORM fragments: the drain runs on the database worker's lean tier,
 * which does not load the ORM. Every argument is a fixed SQL expression, never a value.
 */

export function nonEmpty(expression: string): string {
  return `NULLIF(TRIM(${expression}), '')`;
}

export function isRawIdentifierDisplayName(expression: string): string {
  const trimmed = `TRIM(${expression})`;
  const lowered = `LOWER(${trimmed})`;
  const hex = "[0-9a-fA-F]";
  const uuid = [8, 4, 4, 4, 12].map((length) => hex.repeat(length)).join("-");
  return `(
    ${nonEmpty(expression)} IS NOT NULL
    AND (
      (
        (${trimmed} GLOB '+[0-9]*' OR ${trimmed} GLOB '[0-9]*')
        AND ${trimmed} NOT GLOB '*[A-Za-z]*'
      )
      OR ${lowered} LIKE '%@%'
      OR ${lowered} LIKE 'contacts:%'
      OR ${lowered} LIKE 'imessage:%'
      OR ${lowered} LIKE 'signal:%'
      OR ${lowered} LIKE 'whatsapp:%'
      OR ${lowered} LIKE 'linkedin:%'
      OR ${lowered} LIKE 'slack:%'
      OR ${lowered} LIKE 'urn:li:%'
      OR (LENGTH(${trimmed}) = 36 AND ${trimmed} GLOB '${uuid}')
    )
  )`;
}

export function isHumanDisplayName(expression: string): string {
  return `(${nonEmpty(expression)} IS NOT NULL AND NOT ${isRawIdentifierDisplayName(expression)})`;
}

/** The sender name of the `messages` row in scope: contact, participant, DM name, current. */
const RESOLVED_SENDER_NAME = `(
  WITH resolved AS (
    SELECT
      ${nonEmpty("(SELECT name FROM contacts WHERE id = messages.sender_contact_id)")} AS contact_name,
      ${nonEmpty(`(
        SELECT cp.participant_name
        FROM conversation_participants cp
        WHERE cp.conversation_id = messages.conversation_id
          AND cp.contact_id = messages.sender_contact_id
          AND cp.is_active = 1
        ORDER BY cp.updated_at DESC
        LIMIT 1
      )`)} AS participant_name,
      CASE
        WHEN messages.is_from_me = 0
          AND (
            SELECT type
            FROM conversations
            WHERE id = messages.conversation_id
          ) = 'dm'
          AND (
            SELECT COUNT(*)
            FROM conversation_participants cp2
            WHERE cp2.conversation_id = messages.conversation_id
              AND cp2.is_active = 1
              AND cp2.is_self = 0
          ) = 1
        THEN ${nonEmpty("(SELECT name FROM conversations WHERE id = messages.conversation_id)")}
        ELSE NULL
      END AS dm_name,
      ${nonEmpty("messages.sender_name")} AS current_name
  )
  SELECT CASE
    WHEN ${isHumanDisplayName("contact_name")} THEN contact_name
    WHEN ${isHumanDisplayName("participant_name")} THEN participant_name
    WHEN ${isHumanDisplayName("dm_name")} THEN dm_name
    WHEN ${isHumanDisplayName("current_name")} THEN current_name
    ELSE COALESCE(contact_name, participant_name, current_name)
  END
  FROM resolved
)`;

const RESOLVED_CONVERSATION_NAME =
  "(SELECT name FROM conversations WHERE id = messages.conversation_id)";

/**
 * Re-derives the names of the messages matching `scope` (a WHERE condition on `messages`,
 * which may hold bound parameters) and returns the ids of those whose names changed. Rows
 * whose names are already right are not written, so they are neither rewritten on disk nor
 * reported for search re-indexing.
 */
export function refreshMessageNamesStatement(scope: string): string {
  return `
    UPDATE messages
    SET
      sender_name = ${RESOLVED_SENDER_NAME},
      conversation_name = ${RESOLVED_CONVERSATION_NAME}
    WHERE (${scope})
      AND (
        sender_name IS NOT ${RESOLVED_SENDER_NAME}
        OR conversation_name IS NOT ${RESOLVED_CONVERSATION_NAME}
      )
    RETURNING id
  `;
}
