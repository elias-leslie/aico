export const clock = (value: number | string) =>
  new Date(value).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
export const count = (value: number) => value.toLocaleString('en-US')
