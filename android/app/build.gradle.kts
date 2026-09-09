import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject

plugins {
    id("com.android.application")
}

abstract class SyncWebAssets @Inject constructor(
    private val fileSystemOperations: FileSystemOperations,
) : DefaultTask() {
    @get:InputDirectory
    @get:Optional
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDirectory: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun sync() {
        val source = sourceDirectory.get()
        if (!source.file("embedded.html").asFile.isFile) {
            throw GradleException(
                "Missing ../dist/embedded.html. Build and verify the Web artifact before Android packaging.",
            )
        }
        fileSystemOperations.sync {
            from(source)
            into(outputDirectory)
        }
    }
}

abstract class VerifyReleaseSigning : DefaultTask() {
    @get:Input
    abstract val signingConfigured: Property<Boolean>

    @get:Input
    abstract val requiredVariableNames: ListProperty<String>

    @TaskAction
    fun verify() {
        if (!signingConfigured.get()) {
            throw GradleException(
                "Release signing requires ${requiredVariableNames.get().joinToString(", ")}.",
            )
        }
    }
}

val webDist = rootProject.layout.projectDirectory.dir("../dist")

val signingVariableNames = listOf(
    "OFFLINE_DDZ_KEYSTORE",
    "OFFLINE_DDZ_KEYSTORE_PASSWORD",
    "OFFLINE_DDZ_KEY_ALIAS",
    "OFFLINE_DDZ_KEY_PASSWORD",
)
val hasReleaseSigning = signingVariableNames.all { providers.environmentVariable(it).isPresent }
val verifyReleaseSigning = tasks.register<VerifyReleaseSigning>("verifyReleaseSigning") {
    signingConfigured.set(hasReleaseSigning)
    requiredVariableNames.set(signingVariableNames)
}

android {
    namespace = "io.github.ayauta.offlinedoudizhu"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.ayauta.offlinedoudizhu"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(providers.environmentVariable("OFFLINE_DDZ_KEYSTORE").get())
                storePassword = providers.environmentVariable("OFFLINE_DDZ_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("OFFLINE_DDZ_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("OFFLINE_DDZ_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents {
    onVariants { variant ->
        val variantName = variant.name.replaceFirstChar(Char::uppercaseChar)
        val syncWebAssets = tasks.register<SyncWebAssets>("sync${variantName}WebAssets") {
            sourceDirectory.set(webDist)
            outputDirectory.set(layout.buildDirectory.dir("generated/webAssets/${variant.name}"))
            if (variant.buildType == "release") {
                dependsOn(verifyReleaseSigning)
            }
        }
        variant.sources.assets?.addGeneratedSourceDirectory(
            syncWebAssets,
            SyncWebAssets::outputDirectory,
        )
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.17.0")

}
