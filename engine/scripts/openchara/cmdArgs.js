// Shared scriptevent-argument parser for the test harnesses. A plain
// `.split(/\s+/)` breaks the moment a nickname/squad name has a space in
// it ("March 7th") - this respects double-quotes so a multi-word
// identifier can be passed as one argument: `<ns>:squadjoin sq1 "March 7th"`.

export function parseArgs(message) {
    const args = [];
    const regex = /"([^"]*)"|(\S+)/g;
    let match;
    while ((match = regex.exec(message ?? "")) !== null) {
        args.push(match[1] !== undefined ? match[1] : match[2]);
    }
    return args;
}
