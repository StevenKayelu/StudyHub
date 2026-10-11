/** Generic page for unknown hosts: it never names or hints at any school (BR-60). */
export default function SiteNotFound() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: '40rem',
        margin: '0 auto',
        padding: '2rem 1rem',
      }}
    >
      <h1>Site not found</h1>
      <p>Check the address and try again.</p>
    </main>
  );
}
