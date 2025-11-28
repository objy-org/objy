export default {
    enabled: [],
    log: function(msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('log') != -1) console.log(msg)
    },
    warn: function(msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('warn') != -1) console.warn(msg)
    },
    error: function(msg) {
        if (this.enabled.length == 0 || this.enabled.indexOf('error') != -1) console.error(msg)
    }
}
