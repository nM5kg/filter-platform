// Filter Platform — browser screens: download enqueue helper.
//
// Owns the DownloadManager enqueue path. The FILTER policy check
// (DownloadPolicy.decide) happens BEFORE enqueue, in BrowserActivity —
// this helper just enqueues. The Long returned is the DownloadManager
// id; BrowserActivity stores it on the DownloadRecord via
// DownloadStore.setDownloadManagerId, and DownloadsActivity looks the
// download up by that id directly (no title matching).
//
// Permissions: DownloadManager needs no runtime permission on API 29+.
// On API 26-28 it needs WRITE_EXTERNAL_STORAGE to write into the public
// Downloads directory. enqueue() requests it when the caller is an
// Activity and returns null while the request is pending; the caller
// should check needsStoragePermission() first to show a proper message,
// and re-call enqueue() from onRequestPermissionsResult when the user
// grants it (request code REQUEST_WRITE_STORAGE).
package com.filterplatform.app

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment

object DownloadHelper {

    /** Request code for the pre-Android-10 storage permission request.
     *  BrowserActivity matches this in onRequestPermissionsResult and
     *  re-calls enqueue() when the user grants it. */
    const val REQUEST_WRITE_STORAGE = 9001

    /** True on API 26-28 when WRITE_EXTERNAL_STORAGE is not yet granted
     *  (i.e. enqueue() would return null and ask for it). Always false
     *  on API 29+, where DownloadManager needs no runtime permission. */
    fun needsStoragePermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return false
        return context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
            PackageManager.PERMISSION_GRANTED
    }

    /**
     * Enqueue a download with the system DownloadManager.
     * @param fileName wanted file name, or null to derive it from the URL.
     * @return the DownloadManager id, or null when the download could not
     *  be enqueued — blank URL, no storage permission (requested first on
     *  API 26-28 when [context] is an Activity; the caller re-calls after
     *  the grant), or a DownloadManager failure (bad URL, no Downloads
     *  directory). Callers show a message on null; use
     *  [needsStoragePermission] to tell "permission needed" apart from
     *  "could not start the download".
     */
    fun enqueue(context: Context, url: String, fileName: String?): Long? {
        val cleanUrl = url.trim()
        if (cleanUrl.isBlank()) return null
        val name = fileName?.trim().takeUnless { it.isNullOrBlank() }
            ?: fileNameFor(cleanUrl)
        if (needsStoragePermission(context)) {
            // Ask now; the caller re-enqueues after the grant.
            (context as? Activity)?.requestPermissions(
                arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE),
                REQUEST_WRITE_STORAGE
            )
            return null
        }
        return try {
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
                ?: return null
            val request = DownloadManager.Request(Uri.parse(cleanUrl))
                .setTitle(name)
                .setDescription(cleanUrl)
                .setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                )
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            dm.enqueue(request)
        } catch (_: Throwable) {
            // IllegalArgumentException (bad URL / bad destination),
            // SecurityException, or anything else from the manager:
            // the download did not start.
            null
        }
    }

    /**
     * File name for a URL: the last path segment, sanitised to characters
     * safe in a file name. Falls back to "download" when the URL has no
     * usable last segment (e.g. ends in "/" or is only a host).
     */
    fun fileNameFor(url: String): String {
        val withoutQuery = url.substringBefore("?").substringBefore("#").trim()
        val last = withoutQuery.substringAfterLast("/").trim()
        val cleaned = last
            .replace(Regex("[^A-Za-z0-9._-]+"), "_")
            .trim('_', '.')
            .take(100)
        return cleaned.ifBlank { "download" }
    }
}
