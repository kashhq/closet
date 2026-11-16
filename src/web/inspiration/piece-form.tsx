import {
  GARMENT_COLORS,
  INSPIRATION_PIECE_ROLES,
  PATTERNS,
} from '../../wardrobe/properties';
import type { LookPiece } from '../../wardrobe/recreate';
import { PostForm } from '../form';
import { AutosaveForm } from '../autosave';
import { FormField } from '../form-field';
import { t } from '../i18n';
import { roleGroupLabel, roleLabel, valueLabel } from '../wardrobe/labels';
import { PIECE_KINDS, type PieceKind, pieceKindValue } from './piece-input';
import { INSPIRATION_MAX_PIECES, type StoredPiece } from './queries';
import {
  deleteInspirationPiecePath,
  inspirationPiecePath,
  inspirationPiecesPath,
} from './urls';
import { DENSE_FIELD_GRID } from '../layout/columns';

/**
 * A look's pieces on its page (#22b): what the owner reads in the look,
 * each a role and type, a main colour, an accent and a pattern, the value
 * sets of properties.ts. One select picks the role and type together
 * (`kind`, piece-input.ts), so a type is always its role's and nothing
 * redraws when the role changes; the colours are two selects, so a piece
 * never has more than INSPIRATION_PIECE_MAX_COLORS and the main one comes
 * first. A stored piece is an AutosaveForm (saved as it changes, answered
 * with its status line) beside its own Remove; a new one is a native post,
 * the hints from the look's title (piece-hints.ts) one tap each.
 */

/** A piece in words: "Blazer · Blue, White". */
export function pieceName(piece: LookPiece): string {
  const kind = piece.type
    ? valueLabel('type', piece.type)
    : roleLabel(piece.role);
  if (piece.colors.length === 0) return kind;
  return t('inspiration.PIECE_NAME', {
    kind,
    colors: piece.colors.map((c) => valueLabel('color', c)).join(', '),
  });
}

export function PieceList(props: {
  lookId: number;
  pieces: readonly StoredPiece[];
  hints: readonly LookPiece[];
}) {
  const { lookId, pieces } = props;
  const full = pieces.length >= INSPIRATION_MAX_PIECES;
  return (
    <>
      {pieces.length > 0 && (
        <ul class="flex flex-col gap-3">
          {pieces.map((piece) => (
            <PieceCard lookId={lookId} piece={piece} />
          ))}
        </ul>
      )}
      {!full && props.hints.length > 0 && (
        <div class="flex flex-col gap-2" data-piece-hints="">
          <p class="text-sm text-muted">{t('inspiration.HINTS')}</p>
          <div class="flex flex-wrap gap-2">
            {props.hints.map((hint) => (
              <PostForm action={inspirationPiecesPath(lookId)}>
                <PieceHiddenFields piece={hint} />
                <button type="submit" class="btn btn-sm btn-outline">
                  {t('inspiration.ADD_HINT_PIECE', { piece: pieceName(hint) })}
                </button>
              </PostForm>
            ))}
          </div>
        </div>
      )}
      {full ? (
        <p class="text-sm text-muted">
          {t('inspiration.PIECES_FULL', { max: INSPIRATION_MAX_PIECES })}
        </p>
      ) : (
        // Open while the look has no piece: tagging is the next step.
        <details
          class="collapse collapse-arrow bg-base-200"
          open={pieces.length === 0}
        >
          <summary class="collapse-title text-sm font-medium">
            {t('inspiration.ADD_PIECE')}
          </summary>
          <div class="collapse-content">
            <PostForm
              action={inspirationPiecesPath(lookId)}
              class={DENSE_FIELD_GRID}
            >
              <PieceFields idPrefix="new-piece" piece={NEW_PIECE} />
              <button
                type="submit"
                class="btn btn-primary btn-sm col-span-2 mt-2"
              >
                {t('inspiration.ADD_PIECE_SUBMIT')}
              </button>
            </PostForm>
          </div>
        </details>
      )}
    </>
  );
}

const NEW_PIECE: LookPiece = {
  role: 'top',
  type: null,
  colors: [],
  pattern: null,
};

function PieceCard(props: { lookId: number; piece: StoredPiece }) {
  const { lookId, piece } = props;
  const idPrefix = `piece-${piece.position}`;
  return (
    <li
      class="rounded-box border border-base-300 p-3 flex flex-col gap-1"
      data-piece={piece.position}
    >
      <AutosaveForm
        action={inspirationPiecePath(lookId, piece.position)}
        native
        class={DENSE_FIELD_GRID}
      >
        <PieceFields idPrefix={idPrefix} piece={piece} />
      </AutosaveForm>
      <PostForm
        action={deleteInspirationPiecePath(lookId, piece.position)}
        class="self-end"
      >
        <button type="submit" class="btn btn-ghost btn-xs">
          {t('inspiration.REMOVE_PIECE')}
        </button>
      </PostForm>
    </li>
  );
}

/** The four selects, on a two-column grid: what it is across the top. */
function PieceFields(props: { idPrefix: string; piece: LookPiece }) {
  const { idPrefix, piece } = props;
  const [main, accent] = piece.colors;
  const colorOptions = GARMENT_COLORS.map((color) => ({
    value: color,
    label: valueLabel('color', color),
  }));
  return (
    <>
      <FormField
        id={`${idPrefix}-kind`}
        label={t('inspiration.PIECE_KIND')}
        class="col-span-2"
      >
        <select
          id={`${idPrefix}-kind`}
          name="kind"
          class="select select-bordered w-full"
        >
          {INSPIRATION_PIECE_ROLES.map((role) => (
            <optgroup label={roleGroupLabel(role)}>
              {PIECE_KINDS.filter((kind) => kind.role === role).map((kind) => (
                <option
                  value={pieceKindValue(kind)}
                  selected={
                    kind.role === piece.role && kind.type === piece.type
                  }
                >
                  {kindLabel(kind)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </FormField>
      <PieceSelect
        id={`${idPrefix}-color`}
        name="color"
        label={t('COLOR')}
        value={main ?? ''}
        options={colorOptions}
      />
      <PieceSelect
        id={`${idPrefix}-accent`}
        name="accent"
        label={t('inspiration.PIECE_ACCENT')}
        value={accent ?? ''}
        options={colorOptions}
      />
      <PieceSelect
        id={`${idPrefix}-pattern`}
        name="pattern"
        label={t('PROPERTY_PATTERN')}
        value={piece.pattern ?? ''}
        options={PATTERNS.map((pattern) => ({
          value: pattern,
          label: valueLabel('pattern', pattern),
        }))}
        class="col-span-2"
      />
    </>
  );
}

/** "Any top" for the role alone, else the type's word. */
function kindLabel(kind: PieceKind): string {
  return kind.type === null
    ? t('inspiration.ANY_KIND', { role: roleLabel(kind.role) })
    : valueLabel('type', kind.type);
}

/** One of a value set, or none (''). */
function PieceSelect(props: {
  id: string;
  name: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  class?: string;
}) {
  return (
    <FormField
      id={props.id}
      label={props.label}
      class={props.class ?? 'min-w-0'}
    >
      <select
        id={props.id}
        name={props.name}
        class="select select-bordered w-full"
      >
        <option value="" selected={props.value === ''}>
          {t('inspiration.PIECE_NONE')}
        </option>
        {props.options.map((option) => (
          <option value={option.value} selected={option.value === props.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FormField>
  );
}

/** A hint as the fields PieceBody reads. */
function PieceHiddenFields({ piece }: { piece: LookPiece }) {
  const [main, accent] = piece.colors;
  return (
    <>
      <input type="hidden" name="kind" value={pieceKindValue(piece)} />
      <input type="hidden" name="color" value={main ?? ''} />
      <input type="hidden" name="accent" value={accent ?? ''} />
      <input type="hidden" name="pattern" value={piece.pattern ?? ''} />
    </>
  );
}
