import { useState } from 'react';
import { ChevronRight, ChevronDown, Table2, KeyRound, Link, Diamond, Trash2 } from 'lucide-react';
import type { TableInfo } from '@/hooks/useExplorer';
import type { TableMeta } from '@/hooks/useExplorer';

function formatNum(n: number | null | undefined): string {
  return n != null ? Number(n).toLocaleString() : '?';
}

const keyIcon: Record<string, typeof KeyRound> = {
  PRI: KeyRound,
  MUL: Link,
  UNI: Diamond,
};

interface Props {
  table: TableInfo;
  meta?: TableMeta;
  isActive: boolean;
  onSelect: (name: string) => void;
  /** When true, render a trash icon that triggers `onRequestDrop`. */
  canDrop?: boolean;
  onRequestDrop?: (name: string) => void;
}

export default function TableTreeItem({ table, meta, isActive, onSelect, canDrop = false, onRequestDrop }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      {/* Table row */}
      <div
        className={`group flex items-center text-xs hover:bg-accent transition-colors cursor-pointer ${
          isActive ? 'bg-accent font-medium' : ''
        }`}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="pl-1.5 pr-0.5 py-1.5 text-muted-foreground hover:text-foreground shrink-0"
        >
          {expanded
            ? <ChevronDown className="h-3 w-3" />
            : <ChevronRight className="h-3 w-3" />}
        </button>

        <button
          onClick={() => onSelect(table.TABLE_NAME)}
          className="flex-1 flex items-center justify-between py-1.5 pr-2 min-w-0"
        >
          <span className="truncate">
            <Table2 className="h-3 w-3 inline mr-1.5 opacity-40" />
            {table.TABLE_NAME}
          </span>
          <span className="text-muted-foreground ml-2 shrink-0 tabular-nums">
            {table.CURRENT_ROWS != null
              ? <>{formatNum(table.CURRENT_ROWS)} <span className="opacity-50">/ {formatNum(table.TABLE_ROWS)}</span></>
              : formatNum(table.TABLE_ROWS)}
          </span>
        </button>

        {canDrop && (
          <button
            onClick={e => {
              e.stopPropagation();
              onRequestDrop?.(table.TABLE_NAME);
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity pr-2 py-1.5 text-muted-foreground hover:text-destructive shrink-0"
            title={`Drop ${table.TABLE_NAME}`}
            aria-label={`Drop table ${table.TABLE_NAME}`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && meta && (
        <div className="text-[11px] text-muted-foreground">
          {/* Columns */}
          <div className="pl-6 pr-3 pt-1 pb-0.5 font-medium text-foreground/60 uppercase tracking-wide text-[10px]">
            Columns
          </div>
          {meta.columns.map(col => {
            const Icon = keyIcon[col.key];
            return (
              <div key={col.name} className="flex items-center pl-7 pr-3 py-0.5 gap-1.5 whitespace-nowrap">
                {Icon
                  ? <Icon className="h-3 w-3 shrink-0 text-amber-500" />
                  : <span className="w-3 shrink-0" />}
                <span className="font-mono">{col.name}</span>
                <span className="ml-auto shrink-0 opacity-60">{col.type}</span>
              </div>
            );
          })}

          {/* Indexes */}
          {meta.indexes.length > 0 && (
            <>
              <div className="pl-6 pr-3 pt-1.5 pb-0.5 font-medium text-foreground/60 uppercase tracking-wide text-[10px]">
                Indexes
              </div>
              {meta.indexes.map(idx => (
                <div key={idx.name} className="flex items-center pl-7 pr-3 py-0.5 gap-1.5 whitespace-nowrap">
                  <span className="font-mono">{idx.name}</span>
                  <span className="ml-auto shrink-0 opacity-60">({idx.columns.join(', ')})</span>
                </div>
              ))}
            </>
          )}
          <div className="h-1" />
        </div>
      )}
    </div>
  );
}
