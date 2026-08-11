import { BUILD_ID } from '../app/build';
import { formatDuration } from '../app/format';
import { LIVE, navigate } from '../app/routing';
import type { BundledProgram } from './programs';
import { programsByCategory } from './programs';
import type { ImportedProgram } from './storage';
import './LibraryView.css';

export interface LibraryViewProps {
  onOpenFile: () => void;
  /** Null while IndexedDB is still being read — the section holds off rather than flashing empty. */
  imported: ImportedProgram[] | null;
  onRemoveImported: (id: string) => void;
}

export function LibraryView({ onOpenFile, imported, onRemoveImported }: LibraryViewProps) {
  return (
    <div className="library">
      <header className="library__header">
        <h1>Gnaural Web</h1>
        <p className="library__lede">
          Binaural beat programs. Headphones are required — the effect only exists between two
          ears.
        </p>
        <button type="button" className="button" onClick={onOpenFile}>
          Open a .gnaural file
        </button>
      </header>

      {/* Not a program, so not a program card: it has no author, no length and nothing to load. */}
      <button type="button" className="library__live" onClick={() => navigate(LIVE)}>
        <span className="library__live-title">Live</span>
        <span className="library__live-description">
          Sliders instead of a timeline — set a beat and a tone and listen. Nothing to load.
        </span>
      </button>

      {/* The user's own programs lead: they are the ones that got here on purpose. */}
      {imported && imported.length > 0 && (
        <section className="library__group">
          <h2 className="library__category">Imported</h2>
          <ul className="library__list">
            {imported.map((program) => (
              <li key={program.id} className="library__imported">
                <ImportedCard program={program} />
                <button
                  type="button"
                  className="library__remove"
                  aria-label={`Remove ${program.title}`}
                  onClick={() => onRemoveImported(program.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {programsByCategory().map((group) => (
        <section className="library__group" key={group.category}>
          <h2 className="library__category">{group.label}</h2>
          <ul className="library__list">
            {group.programs.map((program) => (
              <li key={program.id}>
                <ProgramCard program={program} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* The bundled descriptions are upstream prose, preserved verbatim for credit (PLAN.md §10,
          fixtures/presets/README.md), and several of them say what the audio is *for*. PLAN.md §2
          forbids this app making medical claims; attributing them keeps the words where they came
          from instead of putting them in the app's own voice. */}
      <p className="library__attribution">
        The bundled programs' titles and descriptions are their original authors' words, kept as
        they were written. They are not claims made by this app.
      </p>

      {/* An installed PWA can be running a build older than the one you just deployed — the
          service worker waits to be told to swap. Say which one this is. */}
      <p className="library__build">build {BUILD_ID}</p>
    </div>
  );
}

function ProgramCard({ program }: { program: BundledProgram }) {
  return (
    <Card
      title={program.title}
      duration={program.durationSeconds}
      credit={program.author}
      description={program.description}
      onClick={() => navigate({ view: 'program', id: program.id })}
    />
  );
}

function ImportedCard({ program }: { program: ImportedProgram }) {
  return (
    <Card
      title={program.title}
      duration={program.durationSeconds}
      // The file it came from, since an imported program often has no author of its own.
      credit={program.author || program.sourceName}
      description={program.description}
      onClick={() => navigate({ view: 'imported', id: program.id })}
    />
  );
}

interface CardProps {
  title: string;
  duration: number;
  credit: string;
  description: string;
  onClick: () => void;
}

function Card({ title, duration, credit, description, onClick }: CardProps) {
  return (
    <button type="button" className="program-card" onClick={onClick}>
      <span className="program-card__title">{title}</span>
      <span className="program-card__meta">
        {formatDuration(duration)}
        {/* One bundled preset is uncredited upstream; the rest carry a credit that must not be
            dropped (fixtures/presets/README.md). */}
        {credit && <> · {credit}</>}
      </span>
      <span className="program-card__description">{description}</span>
    </button>
  );
}
