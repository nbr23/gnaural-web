import type { CSSProperties } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { PauseIcon, PlayIcon, StopIcon } from '../app/icons';
import { Logo } from '../app/Logo';
import type { Route } from '../app/routing';
import { LIVE, navigate } from '../app/routing';
import { GNAURAL_EXTENSION } from '../files/openFile';
import type { LibraryItem, LibrarySection, NoteSegment } from './catalog';
import { buildCatalog } from './catalog';
import type { Draft, ImportedProgram } from './storage';
import './LibraryView.css';

/** The transport as a row sees it — one object because it is drilled through every section. */
export interface LibraryTransport {
  /** The row whose program is loaded and started, keyed as `LibraryItem.key`. */
  active: { key: string; playing: boolean } | null;
  /** Start this program without opening it. */
  onPlay: (route: Route) => void;
  onPause: () => void;
  onStop: () => void;
}

export interface LibraryViewProps {
  onOpenFile: () => void;
  /** Start a blank draft — the only way into the editor that does not begin with someone else's
   *  program. */
  onNewProgram: () => void;
  /** Null while IndexedDB is still being read — the section holds off rather than flashing empty. */
  imported: ImportedProgram[] | null;
  onRemoveImported: (id: string) => void;
  drafts: Draft[] | null;
  onDiscardDraft: (id: string) => void;
  transport: LibraryTransport;
  /** Route hashes, as `Settings.favourites` stores them. */
  favourites: string[];
  onFavouritesChange: (favourites: string[]) => void;
  /** Sections folded against the depth rule below, by id. See `Settings.sectionOverrides`. */
  overrides: string[];
  onOverridesChange: (overrides: string[]) => void;
}

/**
 * A section's fold state before the user touches it: the top level open, everything nested inside
 * it folded. The bundled programs live one level down in their category groups, so this is the
 * difference between landing on a page of headings and landing on a page of nineteen rows.
 */
function openByDefault(depth: number): boolean {
  return depth === 0;
}

/**
 * The library (PLAN.md §5.1's program list).
 *
 * **A list, not a wall of cards.** Nineteen bundled programs plus everything a user makes is more
 * than a grid of three-line cards can be scanned through: this shows one row per program — colour
 * and badge for where it came from, length, credit — inside collapsible sections, with a search
 * field and a rail that jumps to any of them. What a person came here to do is find one program and
 * press it, and every decision below serves that.
 *
 * The grouping itself lives in `catalog.ts`; this file is the markup and the three pieces of
 * session state a list has: what is typed in the search box, which section is folded, and which row
 * has been asked to confirm a deletion.
 */
const IGNORE_TOGGLE = () => {};

export function LibraryView({
  onOpenFile,
  onNewProgram,
  imported,
  onRemoveImported,
  drafts,
  onDiscardDraft,
  transport,
  favourites,
  onFavouritesChange,
  overrides,
  onOverridesChange,
}: LibraryViewProps) {
  const [query, setQuery] = useState('');

  const sections = useMemo(
    () => buildCatalog({ imported, drafts, favourites, query }),
    [drafts, favourites, imported, query],
  );

  /** Where each section rendered, so the rail can scroll to one without an `href` the router
   *  would then try to read as a route. */
  const anchors = useRef(new Map<string, HTMLElement>());

  const toggleFavourite = useCallback(
    (key: string) => {
      onFavouritesChange(
        favourites.includes(key) ? favourites.filter((held) => held !== key) : [...favourites, key],
      );
    },
    [favourites, onFavouritesChange],
  );

  const setOverride = useCallback(
    (id: string, override: boolean) => {
      // A `toggle` that agrees with what is already stored is not an edit. The stored list arrives
      // after the first render, so every section the user had moved fires one on hydration.
      if (override === overrides.includes(id)) return;
      onOverridesChange(override ? [...overrides, id] : overrides.filter((held) => held !== id));
    },
    [overrides, onOverridesChange],
  );

  const jumpTo = useCallback(
    (id: string, depth: number) => {
      // Jumping to a folded section and leaving it folded shows nothing, so this opens it — which
      // is an override exactly when the section would not have been open anyway.
      setOverride(id, !openByDefault(depth));
      anchors.current.get(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [setOverride],
  );

  const remove = useCallback(
    (item: LibraryItem) => {
      if (item.route.view === 'imported') onRemoveImported(item.route.id);
      else if (item.route.view === 'editor') onDiscardDraft(item.route.id);
    },
    [onDiscardDraft, onRemoveImported],
  );

  return (
    <div className="library">
      <div className="library__body">
        <header className="library__header">
          <div className="library__title">
            <Logo className="library__logo" />
            <h1>Gnaural Web</h1>
          </div>
          <p className="library__lede">
            Binaural beat programs. Headphones are required.
          </p>

          <div className="library__actions">
            <input
              type="search"
              className="library__search"
              value={query}
              placeholder="Search programs"
              aria-label="Search programs"
              onChange={(event) => setQuery(event.target.value)}
            />
            {/* Named for the file it takes, not for the gesture: "Open a file" says nothing about
                which file, and the one thing a newcomer needs to know is that this app reads
                Gnaural's own format. The three tooltips carry what the labels cannot — none of
                these is a program row, so none of them has a description of its own. */}
            <button
              type="button"
              className="button"
              title={`Open a ${GNAURAL_EXTENSION} schedule from this device. It is kept in your library.`}
              onClick={onOpenFile}
            >
              Import {GNAURAL_EXTENSION}
            </button>
            <button
              type="button"
              className="button"
              title="Start an empty program and author it in the editor: voices, frequency curves and timings."
              onClick={onNewProgram}
            >
              New program
            </button>
            {/* Not a program, so not a program row: it has no author, no length and nothing to
                load. */}
            <button
              type="button"
              className="button button--primary"
              title="Play a steady tone you steer by hand — two sliders for the carrier and beat frequency, no timeline. Keep a session as a program at any point."
              onClick={() => navigate(LIVE)}
            >
              Live
            </button>
          </div>
        </header>

        <SectionRail sections={sections} onJump={jumpTo} />

        <div className="library__sections">
          {sections.map((section) => (
            <Section
              key={section.id}
              section={section}
              depth={0}
              overrides={overrides}
              // A search that left its results folded inside a collapsed section would look like a
              // search that found nothing. What is folded is remembered, not applied, while one runs.
              forceOpen={query !== ''}
              favourites={favourites}
              transport={transport}
              anchors={anchors.current}
              // Forcing a section open above fires `toggle` like any other opening would, and that
              // must not be recorded as the user having unfolded it.
              onToggleOpen={query ? IGNORE_TOGGLE : setOverride}
              onToggleFavourite={toggleFavourite}
              onRemove={remove}
            />
          ))}

          {sections.length === 0 && (
            <p className="library__empty">Nothing matches “{query}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The jump list: every section, in the order they appear, indented by depth.
 *
 * Buttons rather than `href="#id"` anchors — the app routes on the fragment (`src/app/routing.ts`),
 * so an anchor would navigate the app as a side effect of scrolling it. It follows the same
 * filtered tree the list does, so it can never offer a section the search has emptied.
 */
function SectionRail({
  sections,
  onJump,
}: {
  sections: LibrarySection[];
  onJump: (id: string, depth: number) => void;
}) {
  const entries = sections.flatMap((section) => [
    { section, depth: 0 },
    ...(section.children ?? []).map((child) => ({ section: child, depth: 1 })),
  ]);

  if (entries.length === 0) return null;

  return (
    <nav className="library__rail" aria-label="Jump to a section">
      {entries.map(({ section, depth }) => (
        <button
          key={section.id}
          type="button"
          className={`library__rail-link${depth > 0 ? ' library__rail-link--child' : ''}`}
          style={section.accent ? ({ '--origin': section.accent } as CSSProperties) : undefined}
          onClick={() => onJump(section.id, depth)}
        >
          {section.accent && <span className="library__dot" aria-hidden="true" />}
          {section.railLabel ?? section.label}
          <span className="library__rail-count">{count(section)}</span>
        </button>
      ))}
    </nav>
  );
}

function count(section: LibrarySection): number {
  return (
    section.items.length +
    (section.children ?? []).reduce((total, child) => total + count(child), 0)
  );
}

interface SectionProps {
  section: LibrarySection;
  depth: number;
  overrides: string[];
  /** Open whatever the depth rule says, without recording it — what a running search does. */
  forceOpen: boolean;
  favourites: string[];
  transport: LibraryTransport;
  anchors: Map<string, HTMLElement>;
  /** Called with whether the section's new state departs from `openByDefault(depth)`. */
  onToggleOpen: (id: string, override: boolean) => void;
  onToggleFavourite: (key: string) => void;
  onRemove: (item: LibraryItem) => void;
}

/**
 * One collapsible group.
 *
 * `<details>` rather than conditional rendering: it keeps its rows in the DOM when closed, so the
 * browser's own find-in-page still reaches them, and it carries the disclosure semantics without
 * any ARIA of ours.
 */
function Section({
  section,
  depth,
  overrides,
  forceOpen,
  favourites,
  transport,
  anchors,
  onToggleOpen,
  onToggleFavourite,
  onRemove,
}: SectionProps) {
  return (
    <details
      className={`library__section library__section--${depth === 0 ? 'top' : 'child'}`}
      open={forceOpen || openByDefault(depth) !== overrides.includes(section.id)}
      ref={(element) => {
        if (element) anchors.set(section.id, element);
        else anchors.delete(section.id);
      }}
      onToggle={(event) =>
        onToggleOpen(section.id, event.currentTarget.open !== openByDefault(depth))
      }
      style={section.accent ? ({ '--origin': section.accent } as CSSProperties) : undefined}
    >
      <summary className="library__summary">
        {/* The disclosure cue. `<summary>` loses its own marker to the flex layout here, and a
            folded-by-default library that shows no way to unfold itself is a dead end. */}
        <svg
          className="library__caret"
          viewBox="0 0 24 24"
          width="1em"
          height="1em"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M9 5.5 16.5 12 9 18.5z" />
        </svg>
        {section.accent && <span className="library__dot" aria-hidden="true" />}
        <span className="library__category">
          {section.code ? (
            <>
              <span className="library__package">{section.code}</span>
              {section.label.slice(section.code.length)}
            </>
          ) : (
            section.label
          )}
        </span>
        <span className="library__count">{count(section)}</span>
      </summary>

      {section.note && <Note segments={section.note} />}

      {section.items.length > 0 && (
        <ul className="library__list">
          {section.items.map((item) => (
            <li key={item.key}>
              <ProgramRow
                item={item}
                transport={transport}
                favourite={favourites.includes(item.key)}
                onToggleFavourite={() => onToggleFavourite(item.key)}
                onRemove={() => onRemove(item)}
              />
            </li>
          ))}
        </ul>
      )}

      {(section.children ?? []).map((child) => (
        <Section
          key={child.id}
          section={child}
          depth={depth + 1}
          overrides={overrides}
          forceOpen={forceOpen}
          favourites={favourites}
          transport={transport}
          anchors={anchors}
          onToggleOpen={onToggleOpen}
          onToggleFavourite={onToggleFavourite}
          onRemove={onRemove}
        />
      ))}
    </details>
  );
}

/** A section's disclaimer: prose, the clause it turns on in bold, and whatever it credits. */
function Note({ segments }: { segments: NoteSegment[] }) {
  return (
    <p className="library__note">
      {segments.map((segment, index) =>
        segment.href ? (
          // Off-site, and the library is a running audio app — a new tab rather than a navigation
          // that would tear down the player to show a store page.
          <a key={index} href={segment.href} target="_blank" rel="noreferrer">
            {segment.text}
          </a>
        ) : segment.strong ? (
          <strong key={index}>{segment.text}</strong>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * One program: a press to open it, a transport that plays it where it stands, a star, and — for the
 * ones that can go — a two-step remove.
 *
 * The removal asks first because it is the only irreversible action in the app and it used to be a
 * single tap on a 32 px `×` at the corner of a card, next to the press that opens the program.
 * Inline rather than `window.confirm`, which on a phone is a system modal for what is a one-word
 * question, and which no test can answer.
 */
function ProgramRow({
  item,
  transport,
  favourite,
  onToggleFavourite,
  onRemove,
}: {
  item: LibraryItem;
  transport: LibraryTransport;
  favourite: boolean;
  onToggleFavourite: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const active = transport.active?.key === item.key ? transport.active : null;
  const playing = active?.playing ?? false;

  return (
    <div
      className={`program-row program-row--${item.origin}${active ? ' is-active' : ''}`}
      style={item.accent ? ({ '--origin': item.accent } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className="program-row__open"
        onClick={() => navigate(item.route)}
      >
        <span className="program-row__title">{item.title}</span>
        <span className="program-row__meta">{item.meta}</span>
        {item.note && <span className="program-row__note">{item.note}</span>}
      </button>

      <span className="program-row__badge">{item.badge}</span>

      <button
        type="button"
        className={`program-row__transport${playing ? ' is-active' : ''}`}
        title={playing ? `Pause ${item.title}` : `Play ${item.title}`}
        aria-label={playing ? `Pause ${item.title}` : `Play ${item.title}`}
        onClick={() => (playing ? transport.onPause() : transport.onPlay(item.route))}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      {active && (
        <button
          type="button"
          className="program-row__transport"
          title={`Stop ${item.title}`}
          aria-label={`Stop ${item.title}`}
          onClick={transport.onStop}
        >
          <StopIcon />
        </button>
      )}

      <button
        type="button"
        className={`program-row__star${favourite ? ' is-active' : ''}`}
        aria-pressed={favourite}
        aria-label={favourite ? `Unfavourite ${item.title}` : `Favourite ${item.title}`}
        onClick={onToggleFavourite}
      >
        {favourite ? '★' : '☆'}
      </button>

      {item.removable &&
        (confirming ? (
          <span className="program-row__confirm">
            <button type="button" className="program-row__action" onClick={onRemove}>
              {item.removable === 'draft' ? 'Discard' : 'Remove'}
            </button>
            <button
              type="button"
              className="program-row__action"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="library__remove"
            aria-label={
              item.removable === 'draft' ? `Discard ${item.title}` : `Remove ${item.title}`
            }
            onClick={() => setConfirming(true)}
          >
            ×
          </button>
        ))}
    </div>
  );
}
