interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export default function Card({ children, className = '' }: CardProps) {
  return (
    <div className={`rounded-lg border border-wv-line bg-wv-panel shadow-wv-sm ${className}`}>
      {children}
    </div>
  );
}
