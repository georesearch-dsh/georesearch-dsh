// The release bundle embeds the published adapter and its @dsh-std runtime
// dependencies so managed rc.5 installations do not need an npm resolution
// step during activation.
export * from '@dsh-std/adapter-dsh'
export { default } from '@dsh-std/adapter-dsh'
