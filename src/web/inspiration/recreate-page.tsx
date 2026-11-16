import type {
  Agreement,
  PieceMatch,
  Recreation,
} from '../../wardrobe/recreate';
import { PostForm } from '../form';
import { inspirationPhotoUrl } from '../files/image-url';
import type { RecreatePoolGarment } from '../gallery/queries';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import { GarmentPicture } from '../layout/parts';
import { SnapStrip, SnapStripsInit, snapItem } from '../strip/snap-strip';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import { lookName } from './look-name';
import { pieceName } from './piece-form';
import {
  wishlisted,
  type InspirationDetail,
  type MatchedGarment,
  type StoredPiece,
} from './queries';
import {
  findPiecePath,
  inspirationPiecesUrl,
  inspirationUrl,
  recreatePieceId,
  saveRecreationPath,
} from './urls';

/**
 * GET /inspiration/:id/recreate, "Recreate this look" (#22b): the look's
 * photo, then each piece the owner tagged with the closet's closest
 * garments (src/wardrobe/recreate.ts), the chosen one centred in a snap
 * strip and the alternates beside it, and the pieces nothing in the closet
 * is close to. Says when a match is not the closest because the closest
 * clashed with the rest, and which pieces it could not make go together.
 *
 * One native post form (#22c): each strip writes its choice (a garment, or
 * None) into its hidden `garment` input beside the piece's `position`, and
 * "Save as outfit" posts them all (saveRecreation). A missing piece's "Find
 * this" is a button of the same form naming its own route (`formaction`,
 * forms cannot nest), and a piece whose match is a wishlist item says so
 * instead, with no strip: its choice is made. The saved garment of a
 * piece stays its chosen one while it is still a match.
 */
export function RecreatePage(props: {
  ctx: ViewContext;
  look: InspirationDetail;
  recreation: Recreation<RecreatePoolGarment>;
}) {
  const { ctx, look, recreation } = props;
  const name = lookName(look);
  const matched = recreation.pieces.filter((p) => p.matches.length > 0).length;
  return (
    <Layout ctx={ctx} title={t('inspiration.RECREATE_TITLE', { title: name })}>
      <AppBar
        ctx={ctx}
        title={t('inspiration.RECREATE')}
        back={inspirationUrl(look.id)}
      />
      <PageMain class="p-4 pt-20 pb-24 flex flex-col gap-4">
        {look.photo && (
          <img
            src={inspirationPhotoUrl(look.photo, 'thumb')}
            alt={t('inspiration.PHOTO_ALT', { title: name })}
            class="w-full max-h-72 object-contain rounded-box bg-base-200"
            decoding="async"
          />
        )}
        {look.pieces.length === 0 ? (
          <div class="flex flex-col gap-2 items-start">
            <p class="text-sm text-muted">{t('inspiration.RECREATE_EMPTY')}</p>
            <a
              href={inspirationPiecesUrl(look.id)}
              class="btn btn-primary btn-sm"
            >
              {t('inspiration.TAG_PIECES')}
            </a>
          </div>
        ) : (
          <>
            <p class="font-semibold" data-recreate-count="">
              {t('inspiration.IN_CLOSET', {
                matched,
                of: look.pieces.length,
              })}
            </p>
            {recreation.unfixed.length > 0 && (
              <div role="status" class="alert alert-warning alert-soft text-sm">
                {t('inspiration.UNFIXED', {
                  pieces: recreation.unfixed
                    .map((index) => pieceName(look.pieces[index]))
                    .join(', '),
                })}
              </div>
            )}
            <PostForm
              action={saveRecreationPath(look.id)}
              class="flex flex-col gap-5"
            >
              <ol class="flex flex-col gap-5">
                {look.pieces.map((piece, index) => (
                  <PieceMatches
                    lookId={look.id}
                    piece={piece}
                    matches={recreation.pieces[index].matches}
                    repicked={recreation.pieces[index].repicked}
                  />
                ))}
              </ol>
              {look.pieces.some((piece, index) =>
                hasStrip(piece, recreation.pieces[index].matches),
              ) && (
                <div class="flex flex-col gap-2">
                  <button type="submit" class="btn btn-primary">
                    {t('inspiration.SAVE_OUTFIT')}
                  </button>
                  <p class="text-xs text-muted">
                    {t('inspiration.SAVE_OUTFIT_HINT')}
                  </p>
                </div>
              )}
            </PostForm>
            <SnapStripsInit />
          </>
        )}
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** Whether the piece is drawn as a strip, whose choice the save posts. */
function hasStrip(
  piece: StoredPiece,
  matches: readonly PieceMatch<RecreatePoolGarment>[],
): boolean {
  return !wishlisted(piece) && matches.length > 0;
}

function PieceMatches(props: {
  lookId: number;
  piece: StoredPiece;
  matches: readonly PieceMatch<RecreatePoolGarment>[];
  repicked: boolean;
}) {
  const { piece, matches } = props;
  const name = pieceName(piece);
  const headingId = recreatePieceId(piece.position);
  return (
    <li
      class="flex flex-col gap-2"
      aria-labelledby={headingId}
      data-recreate-piece={piece.position}
      data-missing={matches.length === 0 && !wishlisted(piece) ? '' : undefined}
    >
      <h2 id={headingId} class="font-medium scroll-mt-20">
        {name}
      </h2>
      <PieceChoice {...props} name={name} />
    </li>
  );
}

/** A piece on the wishlist says so; a missing one offers "Find this"; the rest are a strip. */
function PieceChoice(props: {
  lookId: number;
  piece: StoredPiece;
  name: string;
  matches: readonly PieceMatch<RecreatePoolGarment>[];
  repicked: boolean;
}) {
  const { piece, name } = props;
  const onWishlist = wishlisted(piece);
  if (onWishlist) return <WishlistedPiece item={onWishlist} />;
  if (props.matches.length > 0) return <ChoiceStrip {...props} />;
  return (
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-muted">{t('inspiration.MISSING')}</p>
      <button
        type="submit"
        formaction={findPiecePath(props.lookId, piece.position)}
        class="btn btn-sm btn-outline shrink-0"
        aria-label={t('inspiration.FIND_THIS_LABEL', { piece: name })}
      >
        {t('inspiration.FIND_THIS')}
      </button>
    </div>
  );
}

/**
 * The piece's matches to choose from, then None. The first match is the
 * chosen one: the garment saved last time while it is still a match, else
 * the closest that goes with the rest (recreateLook pins saved choices). Its `position` comes first, so the save reads the two
 * fields as pairs in document order; the strip's own input is its
 * `garment` (the strip's contract: right after it).
 */
function ChoiceStrip(props: {
  piece: StoredPiece;
  name: string;
  matches: readonly PieceMatch<RecreatePoolGarment>[];
  repicked: boolean;
}) {
  const { piece, matches } = props;
  const chosen = matches[0].garment.id;
  return (
    <>
      {props.repicked && (
        <p class="text-xs text-muted">{t('inspiration.REPICKED')}</p>
      )}
      <input type="hidden" name="position" value={String(piece.position)} />
      <SnapStrip
        name="garment"
        value={String(chosen)}
        size="regular"
        label={t('inspiration.MATCHES_LABEL', { piece: props.name })}
        focusable
        // Room for the chosen tile's ring: the strip clips its overflow.
        class="py-1"
      >
        {matches.map((match) => (
          <MatchTile match={match} selected={match.garment.id === chosen} />
        ))}
        <NoMatchTile />
      </SnapStrip>
    </>
  );
}

/** The piece is on the wishlist: its item, one tap away. */
function WishlistedPiece({ item }: { item: MatchedGarment }) {
  return (
    <p class="text-sm flex items-center gap-2" data-wishlisted={item.id}>
      <span class="badge badge-soft badge-primary">
        {t('inspiration.ON_WISHLIST')}
      </span>
      <a href={garmentUrl(item.id, undefined)} class="link">
        {item.name ?? categoryLabel(item.category)}
      </a>
    </p>
  );
}

function MatchTile(props: {
  match: PieceMatch<RecreatePoolGarment>;
  selected: boolean;
}) {
  const { garment, agrees } = props.match;
  const name = garment.name ?? categoryLabel(garment.category);
  return (
    <div
      {...snapItem({
        value: String(garment.id),
        selected: props.selected,
        size: 'regular',
        class: 'flex flex-col gap-1',
      })}
      data-match={garment.id}
    >
      <div class="aspect-square rounded-box bg-base-200 flex items-center justify-center overflow-hidden ring-primary group-data-[selected]/item:ring-2">
        <GarmentPicture photo={garment.photo} loading="lazy" />
      </div>
      <p class="text-sm font-medium line-clamp-1">{name}</p>
      <p class="text-xs text-muted line-clamp-2">
        {agreementText(agrees)}
        {!garment.available && ` · ${t('inspiration.NOT_AVAILABLE')}`}
      </p>
    </div>
  );
}

/** None: the save leaves the piece out (its value is '', as Styling's "No garment"). */
function NoMatchTile() {
  return (
    <div
      {...snapItem({
        value: '',
        selected: false,
        size: 'regular',
        class: 'flex flex-col gap-1',
      })}
      data-no-match=""
    >
      <div
        class="aspect-square rounded-box border border-dashed border-base-300 flex items-center justify-center text-2xl text-muted ring-primary group-data-[selected]/item:ring-2"
        aria-hidden="true"
      >
        —
      </div>
      <p class="text-sm font-medium line-clamp-1">
        {t('inspiration.NO_MATCH')}
      </p>
      <p class="text-xs text-muted line-clamp-2">
        {t('inspiration.NO_MATCH_HINT')}
      </p>
    </div>
  );
}

/** What the match shares with its piece: "Same type · Close color". */
function agreementText(agrees: Agreement): string {
  const parts = [
    agrees.type && t('inspiration.AGREES_TYPE'),
    agrees.color === 'exact' && t('inspiration.AGREES_COLOR'),
    agrees.color === 'close' && t('inspiration.AGREES_CLOSE_COLOR'),
    agrees.pattern && t('inspiration.AGREES_PATTERN'),
  ].filter((part) => typeof part === 'string');
  return parts.length > 0 ? parts.join(' · ') : t('inspiration.AGREES_ROLE');
}
