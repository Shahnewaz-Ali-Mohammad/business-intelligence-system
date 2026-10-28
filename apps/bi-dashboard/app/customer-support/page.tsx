// Dedicated customer-facing entry point. It intentionally shares the same
// ticket thread and API as the internal support console, while giving the
// customer portal its own stable URL for a later public-domain deployment.
export { default } from '@/app/support/chat/page';
