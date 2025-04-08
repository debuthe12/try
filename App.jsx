import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Platform,
  StatusBar, // Import StatusBar
} from 'react-native';
import Video from 'react-native-video';
import dgram from 'react-native-udp';
import { FFmpegKit, ReturnCode, FFmpegKitConfig } from 'ffmpeg-kit-react-native';
import Orientation from 'react-native-orientation-locker'; // Import Orientation Locker

// --- Constants ---
const TELLO_IP = '192.168.10.1';
const TELLO_COMMAND_PORT = 8889;
const TELLO_VIDEO_PORT = 11111; // Tello sends video stream here

const LOCAL_COMMAND_PORT_BIND = 9000; // Local port for sending/receiving commands
const LOCAL_VIDEO_INPUT_PORT = TELLO_VIDEO_PORT; // Port FFmpeg listens on
const LOCAL_VIDEO_OUTPUT_HTTP_PORT = 11112; // Port FFmpeg serves HTTP stream

const App = () => {
  const [errorMessage, setErrorMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false); // Simple flag
  const commandSocket = useRef(null);
  const ffmpegSessionId = useRef(null);
  const videoPlayerRef = useRef(null);

  // --- Simplified Cleanup ---
  const cleanup = useCallback(async () => {
    console.log('Cleaning up...');
    setIsStreaming(false);
    setErrorMessage('');

    // Unlock orientation on cleanup (optional, good practice)
    Orientation.unlockAllOrientations();

    // Cancel FFmpeg
    if (ffmpegSessionId.current) {
      console.log('Cancelling FFmpeg session:', ffmpegSessionId.current);
      try {
        await FFmpegKit.cancel(ffmpegSessionId.current);
      } catch (e) {
        console.error("Error cancelling FFmpeg session:", e);
      } finally {
        ffmpegSessionId.current = null;
      }
    }

    // Close UDP socket
    if (commandSocket.current) {
      console.log('Closing UDP socket');
       try {
           commandSocket.current.close();
       } catch(e) {
           console.error("Error closing socket:", e);
       } finally {
          commandSocket.current = null;
       }
    }
  }, []);

  // --- Setup & Teardown Effects ---
  useEffect(() => {
    // --- Lock Orientation to Landscape ---
    Orientation.lockToLandscape();
    console.log('Locked to Landscape');

    // Enable FFmpegKit logs
    FFmpegKitConfig.enableLogCallback(log => console.log(`FFmpegKit Log: ${log.getMessage()}`));
    FFmpegKitConfig.enableStatisticsCallback(stats => console.log(`FFmpegKit Stats: ${JSON.stringify(stats)}`));

    // Cleanup on component unmount
    return () => {
      cleanup();
    };
  }, [cleanup]); // Depend on cleanup

  // --- Send Command ---
  const sendCommand = (command) => {
    return new Promise((resolve, reject) => {
      if (!commandSocket.current) {
        console.error("sendCommand: Socket not ready.");
        return reject(new Error("Socket not initialized"));
      }
      console.log(`Sending command: ${command}`);
      commandSocket.current.send(command, 0, command.length, TELLO_COMMAND_PORT, TELLO_IP, (err) => {
        if (err) {
          console.error(`Failed to send command ${command}:`, err);
          setErrorMessage(`Failed to send command: ${err.message}`);
          reject(err);
        } else {
          console.log(`Command ${command} sent.`);
          resolve();
        }
      });
    });
  };

  // --- Start FFmpeg Process ---
  const startFFmpeg = async () => {
    setErrorMessage('');
    if (ffmpegSessionId.current) {
        console.warn("FFmpeg session already exists, cancelling previous one.");
        await FFmpegKit.cancel(ffmpegSessionId.current);
        ffmpegSessionId.current = null;
    }

    const ffmpegCommand = `-f h264 -analyzeduration 1000000 -probesize 1000000 -fflags discardcorrupt -fflags nobuffer -flags low_delay -avioflags direct -i udp://0.0.0.0:${LOCAL_VIDEO_INPUT_PORT}?timeout=5000000 -c:v copy -f mpegts -listen 1 http://127.0.0.1:${LOCAL_VIDEO_OUTPUT_HTTP_PORT}`;
    console.log("Starting FFmpeg with command:", ffmpegCommand);

    try {
      const session = await FFmpegKit.executeAsync(ffmpegCommand,
        async (completedSession) => {
            const returnCode = await completedSession.getReturnCode();
            const sessionId = completedSession.getSessionId();
            console.log(`FFmpeg session ${sessionId} completed.`);
             if (ffmpegSessionId.current === sessionId) {
                 ffmpegSessionId.current = null;
             }

            if (ReturnCode.isSuccess(returnCode)) {
                console.log('FFmpeg process finished successfully.');
                if (isStreaming) {
                    console.warn("FFmpeg exited successfully while streaming was active.");
                }
            } else if (ReturnCode.isCancel(returnCode)) {
                console.log('FFmpeg process cancelled.');
            } else {
                console.error('FFmpeg process failed!');
                const logs = await completedSession.getAllLogsAsString();
                console.error('------ FFmpeg Logs Start ------');
                console.error(logs || 'No logs captured.');
                console.error('------ FFmpeg Logs End --------');
                setErrorMessage('FFmpeg Error! Check console logs for details.');
                setIsStreaming(false);
            }
        }
      );

      ffmpegSessionId.current = await session.getSessionId();
      console.log('FFmpeg session starting with ID:', ffmpegSessionId.current);
      setIsStreaming(true);

    } catch (error) {
      console.error('Failed to execute FFmpeg command:', error);
      setErrorMessage(`Failed to start FFmpeg: ${error.message}`);
      setIsStreaming(false);
    }
  };


  // --- Button Handler: Initialize and Start ---
  const handleStartStream = async () => {
    if (isStreaming || commandSocket.current || ffmpegSessionId.current) {
        console.log("Already streaming or attempting to start.");
        return;
    }

    setErrorMessage('');
    setIsStreaming(false);

    try {
      console.log('Creating UDP command socket...');
      commandSocket.current = dgram.createSocket({ type: 'udp4' });

      commandSocket.current.on('error', (err) => {
        const errorMsg = `UDP Socket error: ${err.message}`;
        console.error(errorMsg, err);
        setErrorMessage(errorMsg);
        cleanup();
      });

      commandSocket.current.on('message', (msg, rinfo) => {
        console.log(`Drone response: ${msg.toString()} from ${rinfo.address}:${rinfo.port}`);
      });

      await new Promise((resolve, reject) => {
        commandSocket.current.bind(LOCAL_COMMAND_PORT_BIND, (err) => {
          if (err) {
            const bindError = `Failed to bind socket to port ${LOCAL_COMMAND_PORT_BIND}: ${err.message}`;
            console.error('Socket bind error:', bindError);
            reject(new Error(bindError));
          } else {
            console.log(`Socket bound successfully to port ${LOCAL_COMMAND_PORT_BIND}`);
            resolve();
          }
        });
      });

      await sendCommand('command');
      await new Promise(resolve => setTimeout(resolve, 500));
      await sendCommand('streamon');
      await new Promise(resolve => setTimeout(resolve, 500));

      console.log("Drone commands sent. Starting FFmpeg...");
      await startFFmpeg();

    } catch (error) {
      console.error("Initialization failed:", error);
      setErrorMessage(`Initialization failed: ${error.message}`);
      await cleanup();
    }
  };

  // --- Button Handler for Disconnect ---
  const handleDisconnectPress = () => {
    console.log("Disconnect button pressed.");
    cleanup();
  }

  // --- Video Player Callbacks ---
  const onVideoLoad = () => {
    console.log('Video player loaded stream successfully!');
    if (errorMessage) {
        setErrorMessage('');
    }
  };

  const onVideoError = (err) => {
    console.error('Video player error:', JSON.stringify(err, null, 2));
    const videoErrorMsg = err.error?.localizedDescription || err.error?.localizedFailureReason || err.error?.message || 'Unknown video player error';
    setErrorMessage(`Video Player Error: ${videoErrorMsg}. Check console.`);
  };


  return (
    // Use a standard View instead of SafeAreaView for true fullscreen without potential safe area insets
    <View style={styles.container}>
      {/* Hide the status bar */}
      <StatusBar hidden={true} />

      <View style={styles.content}>

        {/* Error Display Area (kept absolute positioning) */}
        {errorMessage ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Video Area */}
        <View style={styles.videoContainer}>
          {isStreaming ? (
            <Video
              ref={videoPlayerRef}
              source={{ uri: `http://127.0.0.1:${LOCAL_VIDEO_OUTPUT_HTTP_PORT}` }}
              style={styles.video}
              resizeMode="contain" // Or "cover" for full screen fill if aspect ratio differs
              onError={onVideoError}
              onLoad={onVideoLoad}
              repeat={false}
              muted={false}
              allowsExternalPlayback={false}
              paused={!isStreaming}
              // Note: react-native-video also has a 'fullscreen' prop, but we are
              // controlling the whole app's fullscreen state here. You might use
              // the player's fullscreen prop if you wanted *only* the video to
              // go fullscreen on demand (e.g., via a button).
            />
          ) : (
            <View style={styles.placeholder}>
              <Text>Stream Paused / Disconnected</Text>
            </View>
          )}
        </View>

        {/* Control Buttons */}
        {/* Consider moving buttons to overlay on top of video for true fullscreen? */}
        {/* For now, kept at bottom */}
        <View style={styles.buttonContainer}>
          {!isStreaming && !commandSocket.current && !ffmpegSessionId.current ? (
              <TouchableOpacity
                style={styles.button}
                onPress={handleStartStream}
              >
                <Text style={styles.buttonText}>Start Stream</Text>
              </TouchableOpacity>
           ) : (
              <TouchableOpacity
                style={[styles.button, styles.disconnectButton]}
                onPress={handleDisconnectPress}
              >
                <Text style={styles.buttonText}>Disconnect</Text>
              </TouchableOpacity>
           )}
        </View>
      </View>
    </View>
  );
};

// --- Styles (Adjusted slightly) ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000', // Make background black for fullscreen feel
  },
  content: {
    flex: 1,
    justifyContent: 'space-between', // Keep buttons at bottom for now
     // Remove padding if you want edge-to-edge video/controls
  },
  errorContainer: {
    backgroundColor: 'rgba(255, 205, 210, 0.8)', // Semi-transparent error background
    padding: 10,
    margin: 10,
    borderRadius: 4,
    position: 'absolute',
    top: 10, // Adjust positioning as needed in landscape
    left: 10,
    right: 10,
    zIndex: 10,
  },
  errorText: {
    color: '#b71c1c',
    fontSize: 14,
    textAlign: 'center',
  },
  videoContainer: {
    flex: 1, // Take most space
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    // Remove margin if you want edge-to-edge video
    // marginVertical: 10,
  },
  video: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#333', // Darker placeholder
  },
  buttonContainer: {
    // Make buttons overlay on bottom? Example:
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    zIndex: 5, // Ensure buttons are above video if overlaying
    flexDirection: 'row', // Arrange buttons side-by-side if needed
    justifyContent: 'center', // Center button(s)

    // Original styles (buttons below video):
    // padding: 20,
    // paddingBottom: 40,
  },
  button: {
    backgroundColor: 'rgba(33, 150, 243, 0.7)', // Semi-transparent buttons
    paddingVertical: 12, // Slightly smaller padding
    paddingHorizontal: 25,
    borderRadius: 20, // Rounded buttons
    alignItems: 'center',
    marginHorizontal: 10, // Space if multiple buttons
  },
  disconnectButton: {
      backgroundColor: 'rgba(244, 67, 54, 0.7)', // Semi-transparent red
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default App;