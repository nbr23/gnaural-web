import { BUILD_ID } from '../app/build';
import { formatDuration } from '../app/format';
import { navigate } from '../app/routing';
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
