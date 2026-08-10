import { formatDuration } from '../app/format';
import { navigate } from '../app/routing';
import type { BundledProgram } from './programs';
import { programsByCategory } from './programs';
import './LibraryView.css';

export interface LibraryViewProps {
  onOpenFile: () => void;
}

export function LibraryView({ onOpenFile }: LibraryViewProps) {
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
    </div>
  );
}

function ProgramCard({ program }: { program: BundledProgram }) {
  return (
    <button
      type="button"
      className="program-card"
      onClick={() => navigate({ view: 'program', id: program.id })}
    >
      <span className="program-card__title">{program.title}</span>
      <span className="program-card__meta">
        {formatDuration(program.durationSeconds)}
        {/* One bundled preset is uncredited upstream; the rest carry a credit that must not be
            dropped (fixtures/presets/README.md). */}
        {program.author && <> · {program.author}</>}
      </span>
      <span className="program-card__description">{program.description}</span>
    </button>
  );
}
