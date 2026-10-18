'use client';
import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

export function ColumnMenu({ columns, hidden = [], onChange }: { columns: string[]; hidden?: string[]; onChange: (hidden: string[]) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger aria-label="Report columns" title="Show or hide columns" className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"><MoreHorizontal size={18}/></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-80 w-64">
      <DropdownMenuItem onClick={() => onChange([])}>Show all columns</DropdownMenuItem>
      <DropdownMenuSeparator/>
      {[...new Set(columns)].map(column => <DropdownMenuCheckboxItem key={column} checked={!hidden.includes(column)} closeOnClick={false} onCheckedChange={checked => onChange(checked ? hidden.filter(key => key !== column) : [...hidden, column])} className="break-words">{column}</DropdownMenuCheckboxItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
